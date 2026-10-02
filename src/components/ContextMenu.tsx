import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { cn } from "../lib/cn";
import { useUi, type MenuItem } from "../store/ui";

const MARGIN = 8;

interface Anchor {
  x: number;
  y: number;
  /** Right edge to align against when there's no room to the right (submenus flip left). */
  flipX?: number;
}

function MenuList({ items, x, y, flipX, onClose }: { items: MenuItem[]; onClose: () => void } & Anchor) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [open, setOpen] = useState<(Anchor & { index: number }) | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    if (left + width > vw - MARGIN) left = flipX != null ? flipX - width : vw - width - MARGIN;
    setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, Math.min(y, vh - height - MARGIN)) });
  }, [x, y, flipX]);

  const openSub = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen({ index, x: r.right + 4, y: r.top - 6, flipX: r.left - 4 });
  };

  return (
    <>
    <motion.div
      ref={ref}
      role="menu"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 max-h-[70vh] min-w-52 max-w-72 origin-top-left overflow-y-auto rounded-2xl border border-white/10 bg-[color-mix(in_oklab,var(--bg)_70%,#2a2a2e)] p-1.5 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.6)]"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 h-px bg-line" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            aria-haspopup={item.submenu ? "menu" : undefined}
            onMouseEnter={(e) => (item.submenu ? openSub(i, e.currentTarget) : setOpen(null))}
            onClick={(e) => {
              if (item.submenu) return openSub(i, e.currentTarget);
              item.onSelect?.();
              onClose();
            }}
            className={cn(
              "flex h-9 w-full items-center justify-between gap-6 rounded-md px-3 text-left text-sm transition-colors",
              item.danger ? "text-[#ff8a80] hover:bg-[#ff8a80]/10" : "text-ink hover:bg-white/[0.08]",
              open?.index === i && "bg-white/[0.08]",
            )}
          >
            <span className="truncate">{item.label}</span>
            {item.submenu && <CaretRight size={14} className="text-ink-muted" />}
          </button>
        ),
      )}
    </motion.div>
    {open && items[open.index]?.submenu && (
      <MenuList key={open.index} items={items[open.index].submenu!} x={open.x} y={open.y} flipX={open.flipX} onClose={onClose} />
    )}
    </>
  );
}

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[role="menu"]')) close();
    };
    const onBlur = () => close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    document.addEventListener("wheel", onBlur, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      document.removeEventListener("wheel", onBlur);
    };
  }, [menu, close]);

  if (!menu) return null;
  return <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onClose={close} />;
}
