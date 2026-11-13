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

const dialogStack: {panel: HTMLElement; backdrop: HTMLElement; root: HTMLElement | null}[] = [];
const backgroundAttributes = new Map<HTMLElement, {inert: string | null; hidden: string | null}>();
export function hasOpenDialog() {return dialogStack.length > 0;}
function updateDialogStack() {
  for (const entry of dialogStack) {
    const top = entry === dialogStack.at(-1);
    entry.backdrop.toggleAttribute('inert', !top);
    if (top) entry.backdrop.removeAttribute('aria-hidden');
    else entry.backdrop.setAttribute('aria-hidden', 'true');
  }
  for (const [root, previous] of backgroundAttributes) {
    if (dialogStack.some(entry => entry.root === root)) continue;
    if (previous.inert === null) root.removeAttribute('inert'); else root.setAttribute('inert', previous.inert);
    if (previous.hidden === null) root.removeAttribute('aria-hidden'); else root.setAttribute('aria-hidden', previous.hidden);
    backgroundAttributes.delete(root);
  }
}

export function Dialog(props: {
  children: ReactNode;
  description?: ReactNode;
  dismissible?: boolean;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose?: () => void;
  open: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "search";
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
    const panel = panelRef.current;
    if (!panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const root = document.querySelector<HTMLElement>("#root");
    if (root && !backgroundAttributes.has(root)) backgroundAttributes.set(root, {inert: root.getAttribute('inert'), hidden: root.getAttribute('aria-hidden')});
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");
    const entry = {panel, backdrop: panel.parentElement!, root};
    dialogStack.push(entry);
    updateDialogStack();

    const focusTimer = window.setTimeout(() => {
      if (dialogStack.at(-1) !== entry) return;
      if (panelRef.current?.contains(document.activeElement)) return;
      const target = props.initialFocusRef?.current
        ?? panelRef.current?.querySelector<HTMLElement>(focusableSelector)
        ?? panelRef.current;
      target?.focus();
    }, 0);

    function onKeyDown(event: KeyboardEvent) {
      if (dialogStack.at(-1) !== entry || event.defaultPrevented) return;
      const closeState = closeStateRef.current;
      if (event.key === "Escape" && !event.isComposing && closeState.dismissible && closeState.onClose) {
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
      if (!entry.panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
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
      const wasTop = dialogStack.at(-1) === entry;
      dialogStack.splice(dialogStack.indexOf(entry), 1);
      updateDialogStack();
      if (!wasTop) return;
      const next = dialogStack.at(-1);
      if (previousFocus?.isConnected && (!next || next.panel.contains(previousFocus))) previousFocus.focus();
      else (next?.panel.querySelector<HTMLElement>(focusableSelector) ?? next?.panel)?.focus();
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
          animate={{ opacity: 1, pointerEvents: "auto" }}
          className={props.variant === "search" ? "ui-dialog-backdrop ui-dialog-backdrop--search" : "ui-dialog-backdrop"}
          exit={{ opacity: 0, pointerEvents: "none" }}
          initial={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && dismissible && dialogStack.at(-1)?.panel === panelRef.current) props.onClose?.();
          }}
          transition={{ duration: props.variant === "search" ? 0 : reduceMotion ? 0.1 : 0.18 }}
        >
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-describedby={props.description ? descriptionId : undefined}
            aria-labelledby={titleId}
            aria-modal="true"
            className={`ui-dialog ui-dialog--${props.size ?? "md"}${props.variant === "search" ? " ui-dialog--search" : ""}`}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.975, y: reduceMotion ? 0 : 10 }}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.975, y: reduceMotion ? 0 : 10 }}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
            transition={props.variant === "search" ? {duration: 0} : reduceMotion
              ? { duration: 0.1 }
              : { type: "spring", bounce: 0, duration: 0.32 }}
          >
            {props.variant !== "search" && <header className="ui-dialog__header">
              <div>
                <h2 id={titleId}>{props.title}</h2>
                {props.description && <p id={descriptionId}>{props.description}</p>}
              </div>
              {dismissible && props.onClose && (
                <IconButton label="关闭" onClick={props.onClose} variant="ghost"><X size={18} /></IconButton>
              )}
            </header>}
            {props.variant === "search" && <h2 className="ui-dialog__visually-hidden" id={titleId}>{props.title}</h2>}
            <div className="ui-dialog__content">{props.children}</div>
            {props.footer && <footer className="ui-dialog__footer">{props.footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** `children` replaces the fixed note: what the confirmation is about, such as the list a removal affects (s23g2). */
export function ConfirmDialog(props: {
  cancelLabel?: string;
  children?: ReactNode;
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
      {props.children ?? <div className="ui-dialog__notice">请确认后再继续；取消不会做任何修改。</div>}
    </Dialog>
  );
}
