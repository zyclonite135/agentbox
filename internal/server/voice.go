package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxVoicePCM = 30 * 16000 * 2

var voiceInferenceSlot = make(chan struct{}, 1)

var voiceHTTP = &http.Client{
	Timeout:   45 * time.Second,
	Transport: &http.Transport{},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

func whisperPort() int {
	port, err := strconv.Atoi(os.Getenv("AGENTBOX_WHISPER_PORT"))
	if err != nil || port < 1 || port > 65535 {
		return 0
	}
	return port
}

func (s *Server) handleVoiceCapability(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": whisperPort() != 0})
}

func (s *Server) handleVoiceTranscription(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	port := whisperPort()
	if port == 0 {
		http.Error(w, "Voice transcription unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.Header.Get("Content-Type") != "application/octet-stream" {
		http.Error(w, "Expected mono 16 kHz PCM", http.StatusUnsupportedMediaType)
		return
	}

	pcm, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxVoicePCM))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		http.Error(w, "PCM recording exceeds 30 seconds", http.StatusRequestEntityTooLarge)
		return
	}
	if err != nil || len(pcm) == 0 || len(pcm)%2 != 0 {
		http.Error(w, "Invalid PCM recording", http.StatusBadRequest)
		return
	}
	select {
	case voiceInferenceSlot <- struct{}{}:
		defer func() { <-voiceInferenceSlot }()
	default:
		http.Error(w, "Voice transcription busy", http.StatusTooManyRequests)
		return
	}

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "dictation.wav")
	if err != nil {
		http.Error(w, "Cannot create audio form", http.StatusInternalServerError)
		return
	}
	var wav [44]byte
	copy(wav[:], "RIFF")
	binary.LittleEndian.PutUint32(wav[4:], uint32(len(pcm)+36))
	copy(wav[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(wav[16:], 16)
	binary.LittleEndian.PutUint16(wav[20:], 1)
	binary.LittleEndian.PutUint16(wav[22:], 1)
	binary.LittleEndian.PutUint32(wav[24:], 16000)
	binary.LittleEndian.PutUint32(wav[28:], 32000)
	binary.LittleEndian.PutUint16(wav[32:], 2)
	binary.LittleEndian.PutUint16(wav[34:], 16)
	copy(wav[36:], "data")
	binary.LittleEndian.PutUint32(wav[40:], uint32(len(pcm)))
	// All multipart data is written to a bytes.Buffer.
	file.Write(wav[:])
	file.Write(pcm)
	form.WriteField("response_format", "json")
	form.WriteField("language", "ru")
	form.Close()

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+"/inference", &body)
	if err != nil {
		http.Error(w, "Cannot create transcription request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := voiceHTTP.Do(req)
	if err != nil {
		http.Error(w, "Whisper unavailable", http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	var result struct {
		Text *string `json:"text"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&result) != nil || result.Text == nil {
		http.Error(w, "Whisper transcription failed", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": strings.TrimSpace(*result.Text)})
}
