import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  localStorage.setItem("td-theme", t);
}

export function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

/** 响应式读取当前主题（监听 <html> class 变化） */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(getTheme);
  useEffect(() => {
    const obs = new MutationObserver(() => setT(getTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return t;
}

/** recharts 内联样式用的主题色板 */
export function chartPalette(t: Theme) {
  return t === "dark"
    ? { grid: "#1e293b", tick: "#64748b", tooltipBg: "#0f172a", tooltipBorder: "#334155", tooltipText: "#e2e8f0" }
    : { grid: "#e2e8f0", tick: "#64748b", tooltipBg: "#ffffff", tooltipBorder: "#e2e8f0", tooltipText: "#0f172a" };
}
