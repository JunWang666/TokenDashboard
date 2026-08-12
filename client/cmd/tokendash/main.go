// tokendash 命令行入口（headless 模式与调试）。
//
//	login                  loopback 浏览器授权，token 存钥匙串
//	login --service-token  手动录入 service token（headless 备选）
//	run                    无 UI 常驻采集
//	once                   立即采集并上报一次
//	status                 checkpoint、spool 积压、最近上报结果
//	push-credential <p>    把本机凭证推送到 hub
//	config                 生成默认配置文件
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"tokendash/client/internal/auth"
	"tokendash/client/internal/config"
	"tokendash/client/internal/runloop"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "tokendash:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printUsage()
		return nil
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	dir, _ := config.Dir()
	authStore := auth.NewStore(dir)
	runner, err := runloop.New(cfg, authStore)
	if err != nil {
		return err
	}

	switch args[0] {
	case "login":
		return cmdLogin(args[1:], cfg, authStore)
	case "run":
		return runner.Run(nil)
	case "once":
		return runner.Once()
	case "status":
		return cmdStatus(runner)
	case "push-credential":
		return cmdPushCredential(args[1:], runner, authStore)
	case "config":
		if err := cfg.Save(); err != nil {
			return err
		}
		fmt.Println("配置已写入：", mustConfigPath())
		return nil
	case "logout":
		return authStore.ClearAccessCookie()
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		return fmt.Errorf("未知命令 %q", args[0])
	}
}

func cmdLogin(args []string, cfg *config.Config, s *auth.Store) error {
	serviceToken := false
	var team, aud string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--service-token":
			serviceToken = true
		case "--team":
			if i+1 < len(args) {
				team = args[i+1]
				i++
			}
		case "--aud":
			if i+1 < len(args) {
				aud = args[i+1]
				i++
			}
		default:
			return fmt.Errorf("未知参数 %q", args[i])
		}
	}
	if serviceToken {
		fmt.Print("CF-Access-Client-Id: ")
		var id string
		if _, err := fmt.Scanln(&id); err != nil {
			return err
		}
		fmt.Print("CF-Access-Client-Secret: ")
		var secret string
		if _, err := fmt.Scanln(&secret); err != nil {
			return err
		}
		if err := s.SetServiceToken(id, secret); err != nil {
			return err
		}
		fmt.Println("service token 已保存")
		return nil
	}
	if team == "" {
		team = cfg.Team
	}
	if aud == "" {
		aud = cfg.Aud
	}
	res, err := s.LoopbackLogin(team, aud)
	if err != nil {
		return err
	}
	fmt.Println(res.Message)
	if res.URL != "" {
		fmt.Println("若浏览器未自动打开，请手动访问：", res.URL)
	}
	return nil
}

func cmdStatus(runner *runloop.Runner) error {
	st, err := runner.Status()
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	fmt.Println(string(b))
	return nil
}

func cmdPushCredential(args []string, runner *runloop.Runner, s *auth.Store) error {
	if len(args) == 0 {
		return fmt.Errorf("用法: tokendash push-credential <provider> [--value <json>]")
	}
	provider := strings.ToLower(args[0])
	value := ""
	for i := 1; i < len(args); i++ {
		if args[i] == "--value" && i+1 < len(args) {
			value = args[i+1]
			i++
		}
	}
	payload, err := localCredential(provider, value)
	if err != nil {
		return err
	}
	if err := runner.Client.PushCredential(provider, payload); err != nil {
		return err
	}
	fmt.Printf("已推送 %s 凭证（hint 存 hub，明文仅加密存储）\n", provider)
	return nil
}

// localCredential 读取本机各 provider 的凭证。
func localCredential(provider, value string) (any, error) {
	if value != "" {
		var o any
		if err := json.Unmarshal([]byte(value), &o); err == nil {
			return o, nil
		}
		return value, nil
	}
	switch provider {
	case "claude":
		return claudeSessionKey(), nil
	default:
		return nil, fmt.Errorf("provider %q 没有自动读取源；请用 --value 指定", provider)
	}
}

// claudeSessionKey 从 ~/.claude/.credentials.json 读取 sessionKey。
func claudeSessionKey() any {
	home, _ := os.UserHomeDir()
	b, err := os.ReadFile(home + "/.claude/.credentials.json")
	if err != nil {
		return map[string]any{"error": "未找到 ~/.claude/.credentials.json"}
	}
	var cred map[string]any
	if err := json.Unmarshal(b, &cred); err != nil {
		return map[string]any{"error": "解析 .credentials.json 失败"}
	}
	for _, k := range []string{"sessionKey", "primaryApiKey", "apiKey"} {
		if v, ok := cred[k]; ok && v != nil {
			return map[string]any{"session_key": fmt.Sprint(v)}
		}
	}
	return map[string]any{"error": ".credentials.json 中没有 sessionKey"}
}

func mustConfigPath() string {
	p, err := config.Path()
	if err != nil {
		return "?"
	}
	return p
}

func printUsage() {
	fmt.Println(`tokendash — 本地 token 用量采集器

用法:
  tokendash login                  loopback 浏览器授权（Access 登录）
  tokendash login --service-token  手动录入 service token（headless 备选）
  tokendash run                    无 UI 常驻采集
  tokendash once                   立即采集并上报一次
  tokendash status                 checkpoint / spool 积压 / 最近上报
  tokendash push-credential <p>    把本机凭证推送到 hub [--value '{"api_key":"..."}']
  tokendash config                 生成默认配置文件
  tokendash logout                 清除登录态`)
}
