package auth

import "os/exec"

// browserCommand 按平台返回浏览器启动命令。
func browserCommand() (string, []string) {
	switch {
	case isWindows():
		return "rundll32", []string{"url.dll,FileProtocolHandler"}
	case isMac():
		return "open", nil
	default:
		return "xdg-open", nil
	}
}

type proc struct {
	cmd  string
	args []string
}

func newProc(cmd string, args ...string) *proc { return &proc{cmd: cmd, args: args} }

func (p *proc) start(arg string) error {
	return exec.Command(p.cmd, append(p.args, arg)...).Start()
}
