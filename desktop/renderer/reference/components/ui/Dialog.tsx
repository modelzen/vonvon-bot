import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, InlineNotice } from "./index";

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Dialog(props: {
  children: ReactNode;
  description?: ReactNode;
  dismissible?: boolean;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose?: () => void;
  open: boolean;
  size?: "sm" | "md" | "lg";
  title: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const dismissible = props.dismissible ?? Boolean(props.onClose);
  const closeStateRef = useRef({ dismissible, onClose: props.onClose });
  closeStateRef.current = { dismissible, onClose: props.onClose };

  useEffect(() => {
    if (!props.open || typeof document === "undefined") return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const root = document.querySelector<HTMLElement>("#root");
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");

    const focusTimer = window.setTimeout(() => {
      const target = props.initialFocusRef?.current
        ?? panelRef.current?.querySelector<HTMLElement>(focusableSelector)
        ?? panelRef.current;
      target?.focus();
    }, 0);

    function onKeyDown(event: KeyboardEvent) {
      const closeState = closeStateRef.current;
      if (event.key === "Escape" && closeState.dismissible && closeState.onClose) {
        event.preventDefault();
        closeState.onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      root?.removeAttribute("inert");
      root?.removeAttribute("aria-hidden");
      previousFocus?.focus();
    };
  }, [props.initialFocusRef, props.open]);

  if (typeof document === "undefined") {
    return props.open ? (
      <div aria-describedby={props.description ? descriptionId : undefined} aria-labelledby={titleId} aria-modal="true" role="dialog">
        <h2 id={titleId}>{props.title}</h2>
        {props.description && <p id={descriptionId}>{props.description}</p>}
        {props.children}
        {props.footer}
      </div>
    ) : null;
  }

  return createPortal(
    <AnimatePresence>
      {props.open && (
        <motion.div
          animate={{ opacity: 1 }}
          className="ui-dialog-backdrop"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && dismissible) props.onClose?.();
          }}
          transition={{ duration: reduceMotion ? 0.1 : 0.18 }}
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-describedby={props.description ? descriptionId : undefined}
            aria-labelledby={titleId}
            aria-modal="true"
            className={`ui-dialog ui-dialog--${props.size ?? "md"}`}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.985, y: reduceMotion ? 0 : 7 }}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.975, y: reduceMotion ? 0 : 10 }}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
            transition={reduceMotion
              ? { duration: 0.1 }
              : { type: "spring", bounce: 0, duration: 0.32 }}
          >
            <header className="ui-dialog__header">
              <div>
                <h2 id={titleId}>{props.title}</h2>
                {props.description && <p id={descriptionId}>{props.description}</p>}
              </div>
              {dismissible && props.onClose && (
                <IconButton label="关闭" onClick={props.onClose} variant="ghost"><X size={18} /></IconButton>
              )}
            </header>
            <div className="ui-dialog__content">{props.children}</div>
            {props.footer && <footer className="ui-dialog__footer">{props.footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function ConfirmDialog(props: {
  cancelLabel?: string;
  confirmLabel?: string;
  description: ReactNode;
  error?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  onDismiss?: () => void;
  open: boolean;
  pending?: boolean;
  title: ReactNode;
  tone?: "primary" | "danger";
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      description={props.description}
      footer={(
        <>
          <Button disabled={props.pending} onClick={props.onCancel} ref={cancelRef}>{props.cancelLabel ?? "取消"}</Button>
          <Button
            loading={props.pending}
            onClick={props.onConfirm}
            ref={confirmRef}
            variant={props.tone === "danger" ? "danger" : "primary"}
          >
            {props.confirmLabel ?? "确认"}
          </Button>
        </>
      )}
      initialFocusRef={props.tone === "danger" ? cancelRef : confirmRef}
      onClose={props.pending ? undefined : (props.onDismiss ?? props.onCancel)}
      open={props.open}
      size="sm"
      title={props.title}
    >
      {props.error && (
        <InlineNotice title="操作失败" tone="danger">{props.error}</InlineNotice>
      )}
      <div className="ui-dialog__notice">请确认后再继续；取消不会修改任何本机数据。</div>
    </Dialog>
  );
}
