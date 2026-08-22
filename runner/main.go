// tokendash-runner：独立额度采集器（Go 版）。
// 从 hub 拉取凭证 → 各适配器采集额度 → 上报快照，与 cloudflare-hub 内置 runner 同构，
// 用于部署在非 Cloudflare 网络的机器上（api.kimi.com 等的 WAF 会拦截 Workers 出口请求）。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tokendash/runner/internal/adapter"
	"tokendash/runner/internal/hub"
)

type config struct {
	hubURL    string
	auth      map[string]string
	providers map[string]bool // 白名单，空 = 全部已实现的适配器
	interval  time.Duration
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

	if s := os.Getenv("PROVIDERS"); s != "" {
		cfg.providers = map[string]bool{}
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				cfg.providers[p] = true
			}
		}
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
		if len(cfg.providers) > 0 && !cfg.providers[provider] {
			continue
		}
		if adapter.Lookup(provider) == nil {
			continue // 该 provider 无 Go 适配器（由 Cloudflare 侧 runner 负责）
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

	log.Printf("tokendash-runner 启动: hub=%s interval=%s providers=%v", cfg.hubURL, cfg.interval, enabledProviders(cfg))
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
		}
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

func enabledProviders(cfg config) []string {
	if len(cfg.providers) == 0 {
		return adapter.Providers()
	}
	out := make([]string, 0, len(cfg.providers))
	for p := range cfg.providers {
		out = append(out, p)
	}
	return out
}
