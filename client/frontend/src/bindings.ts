// Wails 前端绑定类型。window.go.uiapi.<Method> 由 Wails 自动生成。
declare global {
  interface Window {
    go?: {
      uiapi?: {
        Status(): Promise<Record<string, any>>;
        Login(): Promise<{ ok: boolean; message: string }>;
        Logout(): Promise<null>;
        CollectNow(): Promise<Record<string, any>>;
        SaveConfig(cfg: Record<string, any>): Promise<null>;
        PushCredential(provider: string, payload: any): Promise<null>;
      };
    };
  }
}

export const api = {
  async Status() {
    if (!window.go?.uiapi) throw new Error("未检测到 Wails 运行时（请用桌面应用启动）");
    return window.go.uiapi.Status();
  },
  Login: () => window.go!.uiapi!.Login(),
  Logout: () => window.go!.uiapi!.Logout(),
  CollectNow: () => window.go!.uiapi!.CollectNow(),
  SaveConfig: (cfg: any) => window.go!.uiapi!.SaveConfig(cfg),
  PushCredential: (p: string, payload: any) => window.go!.uiapi!.PushCredential(p, payload),
};

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
