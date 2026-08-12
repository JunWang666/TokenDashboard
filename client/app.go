//go:build wails

// Wails 桌面应用入口：go build -tags wails 或 wails build。
package main

import (
	"context"
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"tokendash/client/internal/auth"
	"tokendash/client/internal/config"
	"tokendash/client/internal/runloop"
	"tokendash/client/internal/uiapi"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal("加载配置失败: ", err)
	}
	dir, _ := config.Dir()
	authStore := auth.NewStore(dir)
	runner, err := runloop.New(cfg, authStore)
	if err != nil {
		log.Fatal("初始化失败: ", err)
	}
	api := uiapi.New(cfg, authStore, runner)

	err = wails.Run(&options.App{
		Title:  "TokenDashboard",
		Width:  1080,
		Height: 720,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: func(_ context.Context) {
			// 托盘/常驻由 runloop 负责；启动即开始常驻采集
			go func() {
				if err := runner.Run(nil); err != nil {
					log.Println("采集循环: ", err)
				}
			}()
		},
		Bind: []interface{}{api},
	})
	if err != nil {
		log.Fatal(err)
	}
}
