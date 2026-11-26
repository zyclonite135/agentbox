package linkapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"agentbox/internal/devicelink"
)

// State is what the panel's status light shows.
type State string

const (
	StateStopped    State = "stopped"
	StateConnecting State = "connecting"
	StateOnline     State = "online"
	// StateAuthFailed is terminal until the user re-pairs: the server rejected
	// the stored token, and the panel holds no password to get a new one.
	StateAuthFailed State = "auth_failed"
)

// Status is the supervisor snapshot the panel renders.
type Status struct {
	State  State  `json:"state"`
	Detail string `json:"detail"`
	Since  int64  `json:"since"` // unix millis the current session came online, 0 if not online

	// PingMS is the connection round-trip latency in milliseconds (one decimal), or
	// -1 when offline or not yet sampled.
	PingMS float64 `json:"ping_ms"`
}

// Supervisor owns the connection lifecycle: one connection attempt loop that can
// be started and stopped from the panel, with its state and log observable
// while it runs.
type Supervisor struct {
	log *logRing

	mu     sync.Mutex
	state  State
	detail string
	since  time.Time

	ping    time.Duration // last measured connection round-trip
	pingOK  bool          // a sample has landed for the current online session
	running bool
	cancel  context.CancelFunc
	done    chan struct{}
}

// NewSupervisor returns an idle supervisor.
func NewSupervisor() *Supervisor {
	return &Supervisor{log: newLogRing(500), state: StateStopped}
}

// Logf writes a line into the panel's log view.
func (s *Supervisor) Logf(format string, args ...any) { s.log.Printf(format, args...) }

// Logs returns log lines newer than seq, plus the newest sequence number.
func (s *Supervisor) Logs(seq int64) ([]LogLine, int64) { return s.log.Since(seq) }

// Status returns the current snapshot.
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{State: s.state, Detail: s.detail, PingMS: -1}
	if s.state == StateOnline && !s.since.IsZero() {
		st.Since = s.since.UnixMilli()
		if s.pingOK {
			st.PingMS = math.Round(float64(s.ping.Microseconds())/100) / 10
		}
	}
	return st
}

// Running reports whether a connection loop is active.
func (s *Supervisor) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// Start validates cfg and launches the connection loop. It returns an error
// the panel can show directly; the loop itself never fails fatally, it retries.
func (s *Supervisor) Start(cfg Config) error {
	if !cfg.Paired() {
		return errors.New("尚未接入服务器，请先粘贴配对码")
	}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return errors.New("文件连接已经在运行")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.running, s.cancel, s.done = true, cancel, done
	s.state, s.detail = StateConnecting, "正在连接…"
	s.mu.Unlock()

	s.log.Printf("正在连接 %s（用户 %s）", cfg.Server, cfg.User)
	go s.run(ctx, cfg, done)
	return nil
}

// Stop cancels the loop and waits for it to wind down.
func (s *Supervisor) Stop() {
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.mu.Unlock()
	if cancel == nil {
		return
	}
	s.log.Printf("正在停止文件连接…")
	cancel()
	if done != nil {
		<-done
	}
}

func (s *Supervisor) run(ctx context.Context, cfg Config, done chan struct{}) {
	defer close(done)
	defer func() {
		s.mu.Lock()
		s.running, s.cancel, s.done = false, nil, nil
		s.since, s.pingOK = time.Time{}, false
		// An auth failure is the reason we stopped — keep it on screen instead
		// of overwriting it with a bland "stopped".
		if s.state != StateAuthFailed {
			s.state, s.detail = StateStopped, ""
		}
		s.mu.Unlock()
		s.log.Printf("文件连接已停止")
	}()

	folders := folderHandler(cfg.Folders)
	backoff := time.Second

	for {
		if ctx.Err() != nil {
			return
		}
		s.setState(StateConnecting, "正在连接 "+cfg.Server+" …")

		start := time.Now()
		err := s.serveOnce(ctx, cfg, folders)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.log.Printf("文件连接断开：%v", err)
		}

		if errors.Is(err, ErrAuthRejected) {
			s.setState(StateAuthFailed, "登录凭证已失效，请重新配对")
			return
		}

		// A connection that stayed up a while earned a fresh backoff budget.
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		s.setState(StateConnecting, fmt.Sprintf("连接中断，%s 后重试…", backoff))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// serveOnce holds one device connection open until it drops or ctx is done.
func (s *Supervisor) serveOnce(ctx context.Context, cfg Config, folders func(io.ReadWriter)) error {
	sess, err := dialDevice(ctx, cfg)
	if err != nil {
		return err
	}
	defer sess.Close()

	s.mu.Lock()
	s.state, s.detail, s.since, s.pingOK = StateOnline, "", time.Now(), false
	s.mu.Unlock()
	s.log.Printf("文件连接已建立")

	// Sample connection latency alongside the live session; the loop dies when the
	// session drops (Ping errors) or the connection winds down (ctx cancel).
	pingCtx, cancelPing := context.WithCancel(ctx)
	defer cancelPing()
	go s.pingLoop(pingCtx, sess)

	// Stopping the panel must unblock Serve, which is parked in AcceptStream.
	stop := context.AfterFunc(ctx, func() { _ = sess.Close() })
	defer stop()
	return devicelink.Serve(sess, folders)
}

// pingLoop measures the connection round-trip over the live yamux session and
// records it for the panel. It samples immediately, then every 10s, and returns
// once the session goes away or ctx is cancelled.
func (s *Supervisor) pingLoop(ctx context.Context, sess *yamux.Session) {
	for {
		rtt, err := sess.Ping()
		if err != nil {
			return // session going away; the serve loop surfaces the drop
		}
		s.mu.Lock()
		if s.state == StateOnline {
			s.ping, s.pingOK = rtt, true
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func (s *Supervisor) setState(st State, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state, s.detail = st, detail
	if st != StateOnline {
		s.since, s.pingOK = time.Time{}, false
	}
}
