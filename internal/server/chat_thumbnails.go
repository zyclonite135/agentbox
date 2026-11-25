package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	chatThumbnailWidth     = 720
	chatThumbnailHeight    = 520
	chatThumbnailMaxSource = 24 << 20
	chatThumbnailMaxPixels = 16 << 20
	chatThumbnailCacheSize = 24
	chatThumbnailMaxCached = 1 << 20
)

type chatThumbnail struct {
	data        []byte
	contentType string
	etag        string
}

type chatThumbnailEntry struct {
	preview *chatThumbnail
	source  chatImageVersion
	used    time.Time
}

type chatImageVersion struct {
	device   uint64
	inode    uint64
	size     int64
	modified unix.Timespec
	changed  unix.Timespec
}

type chatThumbnailCache struct {
	mu      sync.Mutex
	entries map[string]chatThumbnailEntry
	once    sync.Once
	slot    chan struct{}
}

func statChatImage(f *os.File) (chatImageVersion, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &stat); err != nil {
		return chatImageVersion{}, err
	}
	// Preserve the inode's change time, which changes even when a writer
	// restores the file's size and modification time.
	return chatImageVersion{device: uint64(stat.Dev), inode: stat.Ino, size: stat.Size, modified: stat.Mtim, changed: stat.Ctim}, nil
}

func (c *chatThumbnailCache) lookup(key string, version chatImageVersion) *chatThumbnail {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[key]; ok && entry.source == version {
		entry.used = time.Now()
		c.entries[key] = entry
		return entry.preview
	}
	return nil
}

func (c *chatThumbnailCache) get(ctx context.Context, key string, f *os.File, contentType string) *chatThumbnail {
	version, err := statChatImage(f)
	if err != nil || version.size > chatThumbnailMaxSource {
		return nil
	}
	if thumb := c.lookup(key, version); thumb != nil {
		return thumb
	}
	// One decoder at a time limits memory use when history opens several images.
	// Cached responses can still be served while another image is being decoded.
	c.once.Do(func() { c.slot = make(chan struct{}, 1) })
	select {
	case c.slot <- struct{}{}:
		defer func() { <-c.slot }()
	case <-ctx.Done():
		return nil
	}
	current, err := statChatImage(f)
	if err != nil || current != version || ctx.Err() != nil {
		return nil
	}
	if thumb := c.lookup(key, version); thumb != nil {
		return thumb
	}

	thumb := makeChatThumbnail(io.NewSectionReader(f, 0, version.size), contentType)
	if thumb == nil {
		return nil
	}
	current, err = statChatImage(f)
	if err != nil || current != version {
		return nil
	}
	if len(thumb.data) <= chatThumbnailMaxCached {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.entries == nil {
			c.entries = make(map[string]chatThumbnailEntry)
		}
		if _, exists := c.entries[key]; !exists && len(c.entries) >= chatThumbnailCacheSize {
			var oldest string
			var oldestUse time.Time
			for path, entry := range c.entries {
				if oldestUse.IsZero() || entry.used.Before(oldestUse) {
					oldest, oldestUse = path, entry.used
				}
			}
			delete(c.entries, oldest)
		}
		c.entries[key] = chatThumbnailEntry{preview: thumb, source: version, used: time.Now()}
	}
	return thumb
}

func makeChatThumbnail(file io.Reader, contentType string) *chatThumbnail {
	if contentType != "image/png" && contentType != "image/jpeg" {
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			return nil
		}
		return &chatThumbnail{contentType: contentType, etag: fmt.Sprintf("\"%x\"", hash.Sum(nil))}
	}
	raw, err := io.ReadAll(file)
	if err != nil {
		return nil
	}
	data, media := encodeChatThumbnail(raw, contentType)
	if len(data) > 0 && len(data) < len(raw) {
		return &chatThumbnail{data: data, contentType: media, etag: fmt.Sprintf("\"%x\"", sha256.Sum256(data))}
	}
	// If conversion is unsupported or buys no savings, revalidate the original
	// for the inline URL without keeping a second copy of it in server memory.
	return &chatThumbnail{contentType: contentType, etag: fmt.Sprintf("\"%x\"", sha256.Sum256(raw))}
}

func encodeChatThumbnail(raw []byte, contentType string) ([]byte, string) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > chatThumbnailMaxPixels/cfg.Height {
		return nil, ""
	}
	width, height := cfg.Width, cfg.Height
	if width > chatThumbnailWidth {
		height = max(1, height*chatThumbnailWidth/width)
		width = chatThumbnailWidth
	}
	if height > chatThumbnailHeight {
		width = max(1, width*chatThumbnailHeight/height)
		height = chatThumbnailHeight
	}
	// Preserve animated PNGs and JPEGs whose metadata may determine orientation.
	if contentType == "image/png" && animatedChatPNG(raw) ||
		contentType == "image/jpeg" && bytes.Contains(raw, []byte("Exif\x00\x00")) {
		return nil, ""
	}
	if width == cfg.Width && height == cfg.Height && len(raw) <= 128<<10 {
		return nil, ""
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, ""
	}
	resized := scaleChatThumbnail(src, width, height)
	var output bytes.Buffer
	media := "image/jpeg"
	if resized.Opaque() {
		err = jpeg.Encode(&output, resized, &jpeg.Options{Quality: 84})
	} else {
		media = "image/png"
		err = png.Encode(&output, resized)
	}
	if err != nil {
		return nil, ""
	}
	return output.Bytes(), media
}

func animatedChatPNG(raw []byte) bool {
	// acTL must appear before the first image data chunk in an animated PNG.
	for chunks := raw[8:]; len(chunks) >= 12; {
		length := binary.BigEndian.Uint32(chunks)
		if uint64(length) > uint64(len(chunks)-12) {
			break
		}
		switch string(chunks[4:8]) {
		case "acTL":
			return true
		case "IDAT":
			return false
		}
		chunks = chunks[int(length)+12:]
	}
	return false
}

func scaleChatThumbnail(src image.Image, width, height int) *image.RGBA {
	bounds := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	// Average four samples per output pixel in premultiplied color space.
	for y := range height {
		y0 := bounds.Min.Y + (4*y+1)*bounds.Dy()/(4*height)
		y1 := bounds.Min.Y + (4*y+3)*bounds.Dy()/(4*height)
		for x := range width {
			x0 := bounds.Min.X + (4*x+1)*bounds.Dx()/(4*width)
			x1 := bounds.Min.X + (4*x+3)*bounds.Dx()/(4*width)
			r0, g0, b0, a0 := src.At(x0, y0).RGBA()
			r1, g1, b1, a1 := src.At(x1, y0).RGBA()
			r2, g2, b2, a2 := src.At(x0, y1).RGBA()
			r3, g3, b3, a3 := src.At(x1, y1).RGBA()
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8((r0 + r1 + r2 + r3) / (4 * 257)),
				G: uint8((g0 + g1 + g2 + g3) / (4 * 257)),
				B: uint8((b0 + b1 + b2 + b3) / (4 * 257)),
				A: uint8((a0 + a1 + a2 + a3) / (4 * 257)),
			})
		}
	}
	return dst
}
