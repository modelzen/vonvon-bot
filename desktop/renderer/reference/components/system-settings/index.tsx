import {
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleUserRound,
  Laptop,
  LogIn,
  type LucideIcon,
} from "lucide-react";
import {
  createElement,
  forwardRef,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import "./system-settings-kit.css";

type IconSource = LucideIcon | ReactNode;

export type PreferenceIconTone =
  | "blue"
  | "cyan"
  | "green"
  | "orange"
  | "pink"
  | "purple"
  | "red"
  | "gray";

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function renderIcon(icon: IconSource, size: number): ReactNode {
  if (isValidElement(icon)) {
    return icon;
  }

  if (
    typeof icon === "function"
    || (typeof icon === "object" && icon !== null)
  ) {
    return createElement(icon as LucideIcon, { "aria-hidden": true, size });
  }

  return icon;
}

export function SettingsToolbar(props: {
  backDisabled?: boolean;
  backLabel?: string;
  className?: string;
  forwardDisabled?: boolean;
  forwardLabel?: string;
  onBack?: () => void;
  onForward?: () => void;
  title: ReactNode;
}) {
  const backDisabled = props.backDisabled ?? !props.onBack;
  const forwardDisabled = props.forwardDisabled ?? !props.onForward;

  return (
    <header className={classNames("ss-toolbar", props.className)}>
      <div
        aria-hidden="true"
        className="ss-toolbar__drag-region"
        data-tauri-drag-region=""
      />
      <nav aria-label="浏览历史" className="ss-toolbar__history">
        <button
          aria-label={props.backLabel ?? "返回"}
          className="ss-toolbar__history-button"
          disabled={backDisabled}
          onClick={props.onBack}
          type="button"
        >
          <ChevronLeft aria-hidden="true" size={20} strokeWidth={2.35} />
        </button>
        <span aria-hidden="true" className="ss-toolbar__divider" />
        <button
          aria-label={props.forwardLabel ?? "前进"}
          className="ss-toolbar__history-button"
          disabled={forwardDisabled}
          onClick={props.onForward}
          type="button"
        >
          <ChevronRight aria-hidden="true" size={20} strokeWidth={2.35} />
        </button>
      </nav>
      <h1 className="ss-toolbar__title">{props.title}</h1>
    </header>
  );
}

export function PreferencePage(props: HTMLAttributes<HTMLElement> & {
  label?: string;
}) {
  const { children, className, label, ...rest } = props;
  return (
    <section
      {...rest}
      aria-label={label}
      className={classNames("ss-page", className)}
    >
      <div className="ss-page__content">{children}</div>
    </section>
  );
}

export function PreferenceIntro(props: {
  className?: string;
  description?: ReactNode;
  icon?: IconSource;
  iconTone?: PreferenceIconTone;
  title: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <section className={classNames("ss-intro", props.className)}>
      {props.icon && (
        <PreferenceIcon icon={props.icon} tone={props.iconTone} />
      )}
      <div className="ss-intro__copy">
        <h2>{props.title}</h2>
        {props.description && <p>{props.description}</p>}
      </div>
      {props.trailing && <div className="ss-intro__trailing">{props.trailing}</div>}
    </section>
  );
}

export function PreferenceGroup(props: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  id?: string;
  label?: ReactNode;
}) {
  const generatedId = useId();
  const labelId = props.label ? `${generatedId}-label` : undefined;

  return (
    <section
      aria-labelledby={labelId}
      className={classNames("ss-section", props.className)}
      id={props.id}
    >
      {(props.label || props.action) && (
        <div className="ss-section__header">
          {props.label && <h2 className="ss-section__label" id={labelId}>{props.label}</h2>}
          {props.action && <div className="ss-section__action">{props.action}</div>}
        </div>
      )}
      <div className="ss-group">{props.children}</div>
      {props.footer && <div className="ss-section__footer">{props.footer}</div>}
    </section>
  );
}

export const PreferenceIcon = forwardRef<HTMLSpanElement, {
  className?: string;
  icon: IconSource;
  label?: string;
  size?: "regular" | "large";
  tone?: PreferenceIconTone;
}>(({ className, icon, label, size = "regular", tone = "blue" }, ref) => (
  <span
    aria-hidden={label ? undefined : true}
    aria-label={label}
    className={classNames("ss-icon", `ss-icon--${size}`, className)}
    data-tone={tone}
    ref={ref}
    role={label ? "img" : undefined}
  >
    {renderIcon(icon, size === "large" ? 22 : 14)}
  </span>
));
PreferenceIcon.displayName = "PreferenceIcon";

export function PreferenceRow(props: {
  className?: string;
  description?: ReactNode;
  disabled?: boolean;
  icon?: IconSource;
  iconTone?: PreferenceIconTone;
  onClick?: () => void;
  title: ReactNode;
  tooltip?: string;
  trailing?: ReactNode;
  value?: ReactNode;
}) {
  const described = props.description != null;
  const content = (
    <>
      {props.icon && <PreferenceIcon icon={props.icon} tone={props.iconTone} />}
      <span className="ss-row__copy">
        <span className="ss-row__title">{props.title}</span>
        {described && <span className="ss-row__description">{props.description}</span>}
      </span>
      {props.value != null && <span className="ss-row__value">{props.value}</span>}
      {props.trailing != null && <span className="ss-row__trailing">{props.trailing}</span>}
      {props.onClick && (
        <ChevronRight aria-hidden="true" className="ss-row__chevron" size={15} strokeWidth={2.4} />
      )}
    </>
  );

  if (props.onClick) {
    return (
      <button
        className={classNames(
          "ss-row",
          "ss-row--navigation",
          described && "ss-row--described",
          props.className,
        )}
        data-described={described ? "true" : undefined}
        disabled={props.disabled}
        onClick={props.onClick}
        title={props.tooltip}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div
      aria-disabled={props.disabled || undefined}
      className={classNames(
        "ss-row",
        described && "ss-row--described",
        props.disabled && "ss-row--disabled",
        props.className,
      )}
      data-described={described ? "true" : undefined}
    >
      {content}
    </div>
  );
}

export function NavigationRow(props: Omit<Parameters<typeof PreferenceRow>[0], "onClick"> & {
  onClick: () => void;
}) {
  return <PreferenceRow {...props} onClick={props.onClick} />;
}

export function AccountRow(props: {
  active?: boolean;
  className?: string;
  detail: ReactNode;
  name: ReactNode;
  onClick: () => void;
  signedIn: boolean;
}) {
  return (
    <button
      aria-current={props.active ? "page" : undefined}
      className={classNames("ss-account-row", props.active && "is-active", props.className)}
      onClick={props.onClick}
      type="button"
    >
      <span aria-hidden="true" className="ss-account-row__avatar">
        {props.signedIn
          ? <CircleUserRound size={24} strokeWidth={1.75} />
          : <LogIn size={22} strokeWidth={1.85} />}
      </span>
      <span className="ss-account-row__copy">
        <strong>{props.name}</strong>
        <span>{props.detail}</span>
      </span>
      <ChevronRight aria-hidden="true" className="ss-account-row__chevron" size={14} />
    </button>
  );
}

export const DeviceScopeRow = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "name"> & {
  active?: boolean;
  detail: ReactNode;
  expanded?: boolean;
  name: ReactNode;
}>(({ active, className, detail, expanded, name, type = "button", ...props }, ref) => (
  <button
    {...props}
    aria-expanded={expanded}
    className={classNames("ss-device-row", active && "is-active", className)}
    ref={ref}
    type={type}
  >
    <span aria-hidden="true" className="ss-device-row__icon">
      <Laptop size={17} strokeWidth={1.9} />
    </span>
    <span className="ss-device-row__copy">
      <strong>{name}</strong>
      <span>{detail}</span>
    </span>
    <ChevronsUpDown aria-hidden="true" className="ss-device-row__chevron" size={14} />
  </button>
));
DeviceScopeRow.displayName = "DeviceScopeRow";

export const SettingsPane = PreferencePage;
export const SettingsIntro = PreferenceIntro;
export const SettingsGroup = PreferenceGroup;
export const SettingsRow = PreferenceRow;
export const SettingsLinkRow = NavigationRow;
export const SettingsIcon = PreferenceIcon;
