// tokendash-runner：独立额度采集器（Go 版）。
// 从 hub 拉取凭证 → 各适配器采集额度 → 上报快照，与 cloudflare-hub 内置 runner 同构，
// 用于部署在非 Cloudflare 网络的机器上（api.kimi.com 等的 WAF 会拦截 Workers 出口请求）。
package main

import (
	"context"
	"crypto/subtle"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tokendash/runner/internal/adapter"
	"tokendash/runner/internal/hub"
)

type config struct {
	hubURL        string
	auth          map[string]string
	interval      time.Duration
	listenAddr    string // 非空时启动 HTTP 监听，接收 hub 的 webhook 触发立即采集
	webhookSecret string
}

func configFromEnv() (config, error) {
	cfg := config{interval: 15 * time.Minute}

	cfg.hubURL = strings.TrimRight(os.Getenv("HUB_URL"), "/")
	if cfg.hubURL == "" {
		return cfg, fmt.Errorf("HUB_URL 未配置")
	}

	// 鉴权：本地/调试用 HUB_DEV_TOKEN；生产用 Access service token
	switch tok := os.Getenv("HUB_DEV_TOKEN"); {
	case tok != "":
		cfg.auth = map[string]string{"Authorization": "Bearer " + tok + ":runner"}
	default:
		id, secret := os.Getenv("CF_ACCESS_CLIENT_ID"), os.Getenv("CF_ACCESS_CLIENT_SECRET")
		if id == "" || secret == "" {
			return cfg, fmt.Errorf("需要 HUB_DEV_TOKEN 或 CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET")
		}
		cfg.auth = map[string]string{
			"CF-Access-Client-Id":     id,
			"CF-Access-Client-Secret": secret,
		}
	}

	if s := os.Getenv("INTERVAL"); s != "" {
		d, err := time.ParseDuration(s)
		if err != nil || d < time.Minute {
			return cfg, fmt.Errorf("INTERVAL 非法（如 15m、1h，最小 1m）: %q", s)
		}
		cfg.interval = d
	}

	// webhook 监听：hub 点「立即采集」时 POST /collect 立即触发一轮
	cfg.listenAddr = os.Getenv("LISTEN_ADDR")
	cfg.webhookSecret = os.Getenv("WEBHOOK_SECRET")
	if cfg.listenAddr != "" && cfg.webhookSecret == "" {
		return cfg, fmt.Errorf("配置了 LISTEN_ADDR 时必须同时配置 WEBHOOK_SECRET")
	}

	return cfg, nil
}

// collect 一轮采集。返回写入行数。
func collect(ctx context.Context, cfg config) (int, error) {
	hc := hub.NewClient(cfg.hubURL, cfg.auth)
	creds, err := hc.Credentials(ctx)
	if err != nil {
		return 0, err
	}

	var rows []adapter.Row
	for provider, keys := range creds {
		// hub 已按 runner 身份分工（只发本 runner 该采的 provider）；
		// 无 Go 适配器的 provider 跳过
		if adapter.Lookup(provider) == nil {
			continue
		}
		for _, cred := range keys {
			if _, failed := cred["__error__"]; failed {
				continue
			}
			account := cred["name"]
			if account == "" {
				account = "默认"
			}
			for _, r := range adapter.Run(provider, cred) {
				r.Account = account
				rows = append(rows, r)
			}
		}
	}

	if len(rows) == 0 {
		return 0, nil
	}
	if err := hc.PostQuota(ctx, rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}

func main() {
	once := flag.Bool("once", false, "只采集一轮后退出（调试/cron 场景）")
	flag.Parse()

	cfg, err := configFromEnv()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}

	if *once {
		n, err := collect(context.Background(), cfg)
		if err != nil {
			log.Fatalf("采集失败: %v", err)
		}
		log.Printf("采集完成: %d 行快照", n)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// webhook 触发通道：容量 1，采集已在跑时丢弃多余触发
	triggerCh := make(chan struct{}, 1)
	if cfg.listenAddr != "" {
		go serveWebhook(ctx, cfg, triggerCh)
	}

	log.Printf("tokendash-runner 启动: hub=%s interval=%s listen=%s providers=%v", cfg.hubURL, cfg.interval, orNone(cfg.listenAddr), adapter.Providers())
	run(ctx, cfg)
	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("退出")
			return
		case <-ticker.C:
			run(ctx, cfg)
		case <-triggerCh:
			log.Printf("webhook 触发采集")
			run(ctx, cfg)
		}
	}
}

func orNone(s string) string {
	if s == "" {
		return "(未监听)"
	}
	return s
}

// serveWebhook 提供 POST /collect（Bearer 校验），收到请求即触发一轮采集。
// handler 立即返回 202，采集在主循环 goroutine 里串行执行。
func serveWebhook(ctx context.Context, cfg config, triggerCh chan<- struct{}) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /collect", func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(tok), []byte(cfg.webhookSecret)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		select {
		case triggerCh <- struct{}{}:
			fmt.Fprint(w, `{"ok":true}`)
		default:
			fmt.Fprint(w, `{"ok":true,"note":"collect already in progress"}`)
		}
	})
	srv := &http.Server{Addr: cfg.listenAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Shutdown(context.Background())
	}()
	log.Printf("webhook 监听: %s", cfg.listenAddr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("webhook 服务异常退出: %v", err)
	}
}

func run(ctx context.Context, cfg config) {
	n, err := collect(ctx, cfg)
	if err != nil {
		log.Printf("采集失败: %v", err)
		return
	}
	log.Printf("采集完成: %d 行快照", n)
}
