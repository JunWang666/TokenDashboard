// Package config 管理 tokendash 的 TOML 配置。
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

type Sources struct {
	ClaudeCode bool `toml:"claude_code"`
	Cursor     bool `toml:"cursor"`
}

type Config struct {
	HubURL     string  `toml:"hub_url"`
	DeviceName string  `toml:"device_name"`
	Interval   string  `toml:"interval"` // 采集周期，如 "5m"
	Team       string  `toml:"access_team,omitempty"`
	Aud        string  `toml:"access_aud,omitempty"`
	Sources    Sources `toml:"sources"`
}

func Default() *Config {
	host, _ := os.Hostname()
	return &Config{
		HubURL:     "",
		DeviceName: host,
		Interval:   "5m",
		Sources:    Sources{ClaudeCode: true, Cursor: false},
	}
}

// Dir 返回配置目录：macOS ~/Library/Application Support/tokendash、
// Linux ~/.config/tokendash、Windows %AppData%/tokendash
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "tokendash"), nil
}

func Path() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.toml"), nil
}

func Load() (*Config, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}
	cfg := Default()
	if _, err := toml.DecodeFile(path, cfg); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("config: %w", err)
	}
	return cfg, nil
}

func (c *Config) Save() error {
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(c)
}

func (c *Config) Ensure() error {
	if c.HubURL == "" {
		return fmt.Errorf("hub_url 未配置：编辑 %s 或运行 tokendash config", func() string {
			p, _ := Path()
			return p
		}())
	}
	return nil
}
