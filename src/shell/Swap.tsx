import type { ReactNode } from "react";

/**
 * Nhãn đổi theo trạng thái (Run ↔ Running…, Copy ↔ Copied, Pretty ↔ Raw) mà KHÔNG đổi bề rộng: vẽ chồng cả hai
 * nhãn trong cùng một ô grid, nhãn không dùng ẩn bằng `visibility: hidden` → nút luôn rộng bằng nhãn dài hơn,
 * các nút bên cạnh không bị xô.
 */
export function Swap({ on, a, b }: { on: boolean; /** Hiện khi `on`. */ a: ReactNode; /** Hiện khi không `on`. */ b: ReactNode }) {
  return (
    <span className="swap">
      <span className={on ? undefined : "swap-off"} aria-hidden={!on}>{a}</span>
      <span className={on ? "swap-off" : undefined} aria-hidden={on}>{b}</span>
    </span>
  );
}
