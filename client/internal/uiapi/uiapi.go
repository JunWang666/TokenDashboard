// Package uiapi 暴露给桌面前端（Wails 绑定）的方法。
// 前端调用 window.go.uiapi.<Method>()。
package uiapi

import (
	"encoding/json"
	"errors"
	"time"

	"tokendash/client/internal/auth"
	"tokendash/client/internal/config"
	"tokendash/client/internal/runloop"
)

type API struct {
	Cfg  *config.Config
	Auth *auth.Store
	Run  *runloop.Runner

	// LoopbackLogin 由 UI 层注入（headless CLI 用同一实现）
	loginFn func(team, aud string) (*auth.LoginResult, error)
}

func New(cfg *config.Config, authStore *auth.Store, run *runloop.Runner) *API {
	return &API{Cfg: cfg, Auth: authStore, Run: run}
}

func (a *API) SetLoginFn(fn func(team, aud string) (*auth.LoginResult, error)) { a.loginFn = fn }

// Status 返回采集与登录状态。
func (a *API) Status() (map[string]any, error) {
	st, err := a.Run.Status()
	if err != nil {
		return nil, err
	}
	cookie := a.Auth.AccessCookie()
	st["logged_in"] = cookie != ""
	if cookie != "" {
		if exp := auth.JwtExpiry(cookie); exp > 0 {
			st["login_expires"] = time.Unix(exp, 0).Format(time.RFC3339)
		}
	}
	_, _, hasST := a.Auth.ServiceToken()
	st["service_token"] = hasST
	return st, nil
}

// Login 发起 loopback 登录。
func (a *API) Login() (*auth.LoginResult, error) {
	if a.loginFn != nil {
		return a.loginFn(a.Cfg.Team, a.Cfg.Aud)
	}
	return a.Auth.LoopbackLogin(a.Cfg.Team, a.Cfg.Aud)
}

func (a *API) Logout() error { return a.Auth.ClearAccessCookie() }

// CollectNow 立即采集并上传一轮。
func (a *API) CollectNow() (map[string]any, error) {
	if err := a.Run.Once(); err != nil {
		return nil, err
	}
	return a.Run.Status()
}

// QuotaCurrent 代理 hub /api/v1/quota/current。
func (a *API) QuotaCurrent() (map[string]any, error) {
	b, err := a.Run.Client.FetchQuota()
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PushCredential 把本机凭证推送到 hub。
func (a *API) PushCredential(provider string, payload any) error {
	if payload == nil {
		return errors.New("凭证不能为空")
	}
	return a.Run.Client.PushCredential(provider, payload)
}

// SaveConfig 更新并保存配置。
func (a *API) SaveConfig(cfg config.Config) error {
	a.Cfg.HubURL = cfg.HubURL
	a.Cfg.DeviceName = cfg.DeviceName
	a.Cfg.Interval = cfg.Interval
	a.Cfg.Team = cfg.Team
	a.Cfg.Aud = cfg.Aud
	a.Cfg.Sources = cfg.Sources
	return a.Cfg.Save()
}
