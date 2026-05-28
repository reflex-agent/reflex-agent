import "server-only";

/**
 * Source of the `@host/ui` ESM module served to utility iframes. Shared
 * between the route handler (which bundles + serves it) and the Tailwind
 * compiler in `build.ts` (which scans it for class candidates so utilities
 * receive a stylesheet covering the primitives' baked-in classes).
 */
export const HOST_UI_SOURCE: string = String.raw`import { createElement, forwardRef, useState, useCallback } from "react";

function cls(...parts) {
  return parts.filter(Boolean).join(" ");
}

export const Button = forwardRef(function Button(
  { variant = "default", size = "default", className, ...props },
  ref,
) {
  const v = {
    default: "bg-slate-900 text-white hover:bg-slate-800",
    secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200",
    outline: "border border-slate-300 bg-white hover:bg-slate-50",
    destructive: "bg-red-600 text-white hover:bg-red-700",
    ghost: "hover:bg-slate-100",
  }[variant] ?? "";
  const s = {
    default: "h-9 px-4 py-2 text-sm",
    sm: "h-8 px-3 text-xs",
    lg: "h-11 px-6 text-base",
    icon: "h-9 w-9 p-0",
  }[size] ?? "";
  return createElement("button", {
    ref,
    className: cls(
      "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50 disabled:pointer-events-none",
      v, s, className,
    ),
    ...props,
  });
});

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return createElement("input", {
    ref,
    className: cls(
      "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50",
      className,
    ),
    ...props,
  });
});

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return createElement("textarea", {
    ref,
    className: cls(
      "flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50",
      className,
    ),
    ...props,
  });
});

export function Label({ className, ...props }) {
  return createElement("label", {
    className: cls("text-xs font-medium text-slate-600", className),
    ...props,
  });
}

export function Card({ className, ...props }) {
  return createElement("div", {
    className: cls(
      "rounded-lg border border-slate-200 bg-white shadow-sm",
      className,
    ),
    ...props,
  });
}

export function CardContent({ className, ...props }) {
  return createElement("div", {
    className: cls("p-4", className),
    ...props,
  });
}

export function CardHeader({ className, ...props }) {
  return createElement("div", {
    className: cls("p-4 border-b border-slate-100", className),
    ...props,
  });
}

export function CardTitle({ className, ...props }) {
  return createElement("h3", {
    className: cls("text-base font-semibold", className),
    ...props,
  });
}

export function Badge({ variant = "default", className, ...props }) {
  const v = {
    default: "bg-slate-900 text-white",
    secondary: "bg-slate-100 text-slate-900",
    outline: "border border-slate-300 text-slate-700",
  }[variant] ?? "";
  return createElement("span", {
    className: cls(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
      v, className,
    ),
    ...props,
  });
}

export function ScrollArea({ className, children }) {
  return createElement("div", {
    className: cls("overflow-y-auto", className),
  }, children);
}

// --- Routing --------------------------------------------------------------
// In-memory router for multi-view utilities. The iframe has no address
// bar, so navigation is a state stack, not a URL. Use either the hook
// (manual control) or <RouterView> (renders the active view component).

export function useReflexRoute(initial) {
  const start = typeof initial === "string"
    ? { route: initial, params: {} }
    : (initial && initial.route ? { route: initial.route, params: initial.params || {} } : { route: "", params: {} });
  const [stack, setStack] = useState([start]);
  const current = stack[stack.length - 1];
  const navigate = useCallback((route, params) => {
    setStack((s) => [...s, { route, params: params || {} }]);
  }, []);
  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);
  const replace = useCallback((route, params) => {
    setStack((s) => [...s.slice(0, -1), { route, params: params || {} }]);
  }, []);
  return {
    route: current.route,
    params: current.params,
    canBack: stack.length > 1,
    navigate,
    back,
    replace,
  };
}

// <RouterView routes={{ board: BoardView, detail: DetailView }} initial="board" />
// Each view receives { params, navigate, back, replace, route, canBack }.
export function RouterView({ routes, initial }) {
  const r = useReflexRoute(initial);
  const Comp = routes ? routes[r.route] : null;
  if (typeof Comp !== "function") {
    return createElement(
      "div",
      { className: "p-4 text-sm text-slate-500" },
      "No view for route: " + String(r.route),
    );
  }
  return createElement(Comp, {
    params: r.params,
    navigate: r.navigate,
    back: r.back,
    replace: r.replace,
    route: r.route,
    canBack: r.canBack,
  });
}
`;
