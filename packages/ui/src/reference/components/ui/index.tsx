import { Select } from "@base-ui/react/select";
import "./select-control.css";
import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CircleX,
  Info,
  LoaderCircle,
  Minus,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}>(({ children, className, variant = "secondary", size = "md", loading = false, icon, disabled, ...props }, ref) => (
  <button
    {...props}
    className={classNames("ui-button", `ui-button--${variant}`, `ui-button--${size}`, className)}
    disabled={disabled || loading}
    ref={ref}
  >
    {loading ? <LoaderCircle aria-hidden="true" className="ui-button__spinner" size={15} /> : icon}
    <span>{children}</span>
  </button>
));
Button.displayName = "Button";

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "default" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}>(({ children, className, label, variant = "default", size = "md", loading = false, disabled, ...props }, ref) => (
  <button
    {...props}
    aria-label={label}
    className={classNames("ui-icon-button", `ui-icon-button--${variant}`, `ui-icon-button--${size}`, className)}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    ref={ref}
  >
    {loading ? <LoaderCircle aria-hidden="true" className="ui-button__spinner" size={15} /> : children}
  </button>
));
IconButton.displayName = "IconButton";

export function Card(props: HTMLAttributes<HTMLElement> & {
  as?: "article" | "section" | "div";
  elevated?: boolean;
  interactive?: boolean;
  subtle?: boolean;
}) {
  const { as: Component = "article", className, elevated, interactive, subtle, ...rest } = props;
  return (
    <Component
      {...rest}
      className={classNames(
        "ui-card",
        elevated && "ui-card--elevated",
        interactive && "ui-card--interactive",
        subtle && "ui-card--subtle",
        className,
      )}
    />
  );
}

const statusIcons: Record<StatusTone, LucideIcon> = {
  neutral: Circle,
  info: Info,
  success: CheckCircle2,
  warning: CircleAlert,
  danger: CircleX,
};

export function StatusBadge(props: {
  children: ReactNode;
  className?: string;
  tone?: StatusTone;
  variant?: "inline" | "pill";
}) {
  const { children, className, tone = "neutral", variant = "inline" } = props;
  const Icon = statusIcons[tone];
  return (
    <span className={classNames(
      "ui-status-badge",
      `ui-status-badge--${tone}`,
      variant === "pill" && "ui-status-badge--pill",
      className,
    )}>
      {variant === "pill" && (
        <Icon aria-hidden="true" className="ui-status-badge__icon" />
      )}
      <span>{children}</span>
    </span>
  );
}

export function PageHeader(props: {
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  icon?: LucideIcon;
  iconTone?: "blue" | "cyan" | "green" | "orange" | "pink" | "purple" | "red" | "gray";
  title: string;
}) {
  const Icon = props.icon;
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__main">
        {Icon && (
          <span
            className="ui-page-header__icon"
            data-tone={props.iconTone ?? "blue"}
            aria-hidden="true"
          >
            <Icon size={17} />
          </span>
        )}
        <div className="ui-page-header__copy">
          {props.eyebrow && <p className="eyebrow">{props.eyebrow}</p>}
          <div className="ui-page-header__title-row">
            <h1>{props.title}</h1>
          </div>
          {props.description && <p className="ui-page-header__description">{props.description}</p>}
        </div>
      </div>
      {props.actions && <div className="ui-page-header__actions">{props.actions}</div>}
    </header>
  );
}

export function StatTile(props: {
  detail: ReactNode;
  footer?: ReactNode;
  icon?: LucideIcon;
  label: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
  value: ReactNode;
}) {
  const Icon = props.icon;
  const tone = props.tone ?? "default";
  return (
    <article className={classNames("ui-stat-tile", tone !== "default" && `ui-stat-tile--${tone}`)}>
      <div className="ui-stat-tile__header">
        <span className="ui-stat-tile__label">{props.label}</span>
        {Icon && <Icon aria-hidden="true" color="currentColor" size={16} />}
      </div>
      <strong className="ui-stat-tile__value">{props.value}</strong>
      <p className="ui-stat-tile__detail">{props.detail}</p>
      {props.footer && <div className="ui-stat-tile__footer">{props.footer}</div>}
    </article>
  );
}

export function EmptyState(props: {
  actions?: ReactNode;
  description: ReactNode;
  icon?: LucideIcon;
  title: string;
}) {
  const Icon = props.icon ?? Circle;
  return (
    <article className="ui-empty-state ui-card">
      <span className="ui-empty-state__icon" aria-hidden="true"><Icon size={21} /></span>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.actions && <div className="ui-empty-state__actions">{props.actions}</div>}
    </article>
  );
}

export function InlineNotice(props: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  title: string;
  tone?: StatusTone;
}) {
  const tone = props.tone ?? "neutral";
  const Icon = statusIcons[tone];
  return (
    <div className={classNames("ui-inline-notice", `ui-inline-notice--${tone}`, props.className)} role={tone === "danger" ? "alert" : "status"}>
      <span className="ui-inline-notice__icon" aria-hidden="true"><Icon size={17} /></span>
      <div className="ui-inline-notice__content">
        <strong className="ui-inline-notice__title">{props.title}</strong>
        {props.children && <p>{props.children}</p>}
      </div>
      {props.actions && <div className="ui-inline-notice__actions">{props.actions}</div>}
    </div>
  );
}

/** Wires the description and error to its one child. With `htmlFor` the control sits deeper (an input with a button
 * beside it, s23g2): the caller wires it, and the ids are `${htmlFor}-description` and `${htmlFor}-error`. */
export function FormField(props: {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  label: ReactNode;
  layout?: "stacked" | "setting";
  required?: boolean;
}) {
  const generatedId = useId();
  const base = props.htmlFor ?? generatedId;
  const descriptionId = props.description ? `${base}-description` : undefined;
  const errorId = props.error ? `${base}-error` : undefined;
  const formControl = !props.htmlFor && isValidElement(props.children)
    ? props.children as ReactElement<{
        "aria-describedby"?: string;
        "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
        "aria-required"?: boolean | "false" | "true";
      }>
    : undefined;
  const control = formControl
    ? cloneElement(
        formControl,
        {
          "aria-describedby": [
            formControl.props["aria-describedby"],
            descriptionId,
            errorId,
          ].filter(Boolean).join(" ") || undefined,
          "aria-invalid": props.error ? true : formControl.props["aria-invalid"],
          "aria-required": props.required ? true : formControl.props["aria-required"],
        },
      )
    : props.children;

  return (
    <div
      className={classNames(
        "ui-form-field",
        props.layout === "setting" && "ui-form-field--setting",
        props.className,
      )}
    >
      <label className="ui-form-field__label" htmlFor={props.htmlFor}>
        {props.label}{props.required && <span aria-hidden="true" className="ui-form-field__required"> *</span>}
      </label>
      {control}
      {props.description && <p className="ui-form-field__description" id={descriptionId}>{props.description}</p>}
      {props.error && <p className="ui-form-field__error" id={errorId} role="alert">{props.error}</p>}
    </div>
  );
}

export function Toggle(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  description?: ReactNode;
  label: ReactNode;
}) {
  const { className, description, disabled, label, ...inputProps } = props;
  return (
    <label className={classNames("ui-toggle", disabled && "ui-toggle--disabled", className)}>
      <input {...inputProps} className="ui-toggle__control" disabled={disabled} role="switch" type="checkbox" />
      <span className="ui-toggle__track" aria-hidden="true"><span className="ui-toggle__thumb" /></span>
      <span className="ui-toggle__copy">
        <span className="ui-toggle__label">{label}</span>
        {description && <span className="ui-toggle__description">{description}</span>}
      </span>
    </label>
  );
}

function clampStepperValue(value: number, min?: number, max?: number): number {
  const lowerBound = min !== undefined && Number.isFinite(min) ? min : -Infinity;
  const upperBound = max !== undefined && Number.isFinite(max) ? max : Infinity;
  return Math.min(upperBound, Math.max(lowerBound, value));
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const fractionLength = coefficient?.split(".")[1]?.length ?? 0;
  const exponent = Number(exponentText ?? 0);
  return Math.max(0, fractionLength - exponent);
}

function addStepperValue(value: number, increment: number): number {
  const precision = Math.min(12, Math.max(decimalPlaces(value), decimalPlaces(increment)));
  return Number((value + increment).toFixed(precision));
}

export function NumberStepper(props: {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-required"?: boolean | "false" | "true";
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  const fallbackValue = props.min !== undefined && Number.isFinite(props.min) ? props.min : 0;
  const currentValue = clampStepperValue(
    Number.isFinite(props.value) ? props.value : fallbackValue,
    props.min,
    props.max,
  );
  const increment = props.step !== undefined && Number.isFinite(props.step) && props.step > 0
    ? props.step
    : 1;
  const [draft, setDraft] = useState(String(currentValue));

  useEffect(() => {
    setDraft(String(currentValue));
  }, [currentValue]);

  const emitValue = (nextValue: number) => {
    const clampedValue = clampStepperValue(nextValue, props.min, props.max);
    setDraft(String(clampedValue));
    if (!Object.is(clampedValue, props.value)) props.onChange(clampedValue);
  };

  const parsedDraft = () => {
    if (draft.trim() === "") return undefined;
    const parsedValue = Number(draft);
    return Number.isFinite(parsedValue) ? parsedValue : undefined;
  };

  const changeBy = (direction: -1 | 1) => {
    const baseValue = parsedDraft() ?? currentValue;
    emitValue(addStepperValue(baseValue, increment * direction));
  };

  const commitDraft = () => {
    const parsedValue = parsedDraft();
    if (parsedValue === undefined) {
      setDraft(String(currentValue));
      return;
    }
    emitValue(parsedValue);
  };

  const atMinimum = props.min !== undefined && Number.isFinite(props.min) && currentValue <= props.min;
  const atMaximum = props.max !== undefined && Number.isFinite(props.max) && currentValue >= props.max;

  return (
    <div
      aria-label={props.label}
      className={classNames(
        "ui-number-stepper",
        props.disabled && "ui-number-stepper--disabled",
        props.className,
      )}
      role="group"
    >
      <button
        aria-label={`减少${props.label}`}
        className="ui-number-stepper__button"
        disabled={props.disabled || atMinimum}
        onClick={() => changeBy(-1)}
        type="button"
      >
        <Minus aria-hidden="true" size={12} strokeWidth={2.2} />
      </button>
      <input
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        aria-label={props.label}
        aria-required={props["aria-required"]}
        aria-valuemax={props.max}
        aria-valuemin={props.min}
        aria-valuenow={clampStepperValue(parsedDraft() ?? currentValue, props.min, props.max)}
        className="ui-number-stepper__input"
        disabled={props.disabled}
        id={props.id}
        inputMode={Number.isInteger(increment) ? "numeric" : "decimal"}
        onBlur={commitDraft}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value;
          setDraft(nextDraft);
          if (nextDraft.trim() === "") return;
          const parsedValue = Number(nextDraft);
          if (Number.isFinite(parsedValue)) {
            const clampedValue = clampStepperValue(parsedValue, props.min, props.max);
            if (!Object.is(clampedValue, props.value)) props.onChange(clampedValue);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            changeBy(1);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            changeBy(-1);
          } else if (event.key === "Home" && props.min !== undefined && Number.isFinite(props.min)) {
            event.preventDefault();
            emitValue(props.min);
          } else if (event.key === "End" && props.max !== undefined && Number.isFinite(props.max)) {
            event.preventDefault();
            emitValue(props.max);
          } else if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(currentValue));
          }
        }}
        role="spinbutton"
        type="text"
        value={draft}
      />
      <button
        aria-label={`增加${props.label}`}
        className="ui-number-stepper__button"
        disabled={props.disabled || atMaximum}
        onClick={() => changeBy(1)}
        type="button"
      >
        <Plus aria-hidden="true" size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}

export function SelectControl<T extends string>(props: {
  "aria-describedby"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-required"?: boolean | "false" | "true";
  className?: string;
  /** Keep related fields consistent even when their option counts differ. */
  presentation?: "auto" | "dropdown";
  disabled?: boolean;
  getOptionIcon?: (value: T) => ReactNode;
  id?: string;
  label: string;
  onChange: (value: T) => void;
  options: readonly SelectionOption<T>[];
  value: T;
}) {
  const radioName = useId();
  const labelWidth = (label: string) => Array.from(label).reduce((width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
  const shortOptions = props.presentation !== "dropdown" && props.options.length > 0 && props.options.length <= 5
    && props.options.every(option => typeof option.label === "string" && labelWidth(option.label) <= 16 && !option.description)
    && props.options.reduce((total, option) => total + labelWidth(option.label as string) + (props.getOptionIcon ? 3 : 0), 0) <= 34;
  const optionLabel = (option: SelectionOption<T>) => props.getOptionIcon
    ? <span className="ui-select-option-label"><span className="ui-select-option-icon" aria-hidden="true">{props.getOptionIcon(option.value)}</span><span>{option.label}</span></span>
    : option.label;
  if (shortOptions) return (
    <div
      aria-describedby={props["aria-describedby"]}
      aria-disabled={props.disabled || undefined}
      aria-invalid={props["aria-invalid"]}
      aria-label={props.label}
      aria-labelledby={props["aria-labelledby"]}
      aria-required={props["aria-required"]}
      className={classNames("ui-select-segments", props.className)}
      id={props.id}
      role="radiogroup"
    >
      {props.options.map(option => <label className="ui-select-segment" key={option.value} title={option.label as string}>
        <input type="radio" name={radioName} value={option.value} checked={props.value === option.value} disabled={props.disabled || option.disabled}
          onChange={() => {if (!props.disabled && !option.disabled && option.value !== props.value) props.onChange(option.value);}}/>
        <span>{optionLabel(option)}</span>
      </label>)}
    </div>
  );
  return (
    <Select.Root
      disabled={props.disabled}
      items={props.options}
      onValueChange={(value) => {
        if (!props.disabled && value !== null && value !== props.value && props.options.some(option => option.value === value && !option.disabled)) props.onChange(value);
      }}
      value={props.value}
    >
      <Select.Trigger
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        aria-label={props.label}
        aria-labelledby={props["aria-labelledby"]}
        aria-required={props["aria-required"]}
        className={classNames("ui-select-control", props.className)}
        id={props.id}
      >
        {props.getOptionIcon && props.options.some(option => option.value === props.value) && <span className="ui-select-option-icon" aria-hidden="true">{props.getOptionIcon(props.value)}</span>}
        <Select.Value className="ui-select-control__value" />
        <Select.Icon className="ui-select-control__chevron">
          <ChevronsUpDown aria-hidden="true" size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          align="start"
          alignItemWithTrigger={false}
          className="ui-select-control__positioner"
          collisionPadding={8}
          sideOffset={6}
        >
          <Select.Popup className="ui-select-control__popup">
            <Select.List className="ui-select-control__list">
              {props.options.map((option) => (
                <Select.Item
                  className="ui-select-control__option"
                  disabled={option.disabled}
                  key={option.value}
                  value={option.value}
                >
                  <Select.ItemIndicator className="ui-select-control__indicator">
                    <Check aria-hidden="true" size={13} strokeWidth={2.6} />
                  </Select.ItemIndicator>
                  <Select.ItemText>{optionLabel(option)}</Select.ItemText>
                  {option.recommended && <span className="ui-select-control__recommendation">推荐</span>}
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export interface SelectionOption<T extends string> {
  /** Quiet hint shown in the dropdown menu, never in its selected value. */
  recommended?: boolean;
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

function handleRadioGroupKeyDown<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  options: readonly SelectionOption<T>[],
  currentIndex: number,
  onChange: (value: T) => void,
) {
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const candidateIndex = (currentIndex + offset) % options.length;
      if (!options[candidateIndex]?.disabled) {
        nextIndex = candidateIndex;
        break;
      }
    }
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const candidateIndex = (currentIndex - offset + options.length) % options.length;
      if (!options[candidateIndex]?.disabled) {
        nextIndex = candidateIndex;
        break;
      }
    }
  } else if (event.key === "Home") {
    nextIndex = options.findIndex((option) => !option.disabled);
    if (nextIndex < 0) nextIndex = undefined;
  } else if (event.key === "End") {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) {
        nextIndex = index;
        break;
      }
    }
  }
  const nextOption = nextIndex === undefined ? undefined : options[nextIndex];
  if (nextIndex === undefined || !nextOption) return;
  event.preventDefault();
  onChange(nextOption.value);
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=radio]");
  radios?.[nextIndex]?.focus();
}

function radioTabIndex<T extends string>(
  options: readonly SelectionOption<T>[],
  value: T,
  index: number,
  disabled?: boolean,
): 0 | -1 {
  if (disabled || options[index]?.disabled) return -1;
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const tabbableIndex = selectedIndex >= 0
    ? selectedIndex
    : options.findIndex((option) => !option.disabled);
  return index === tabbableIndex ? 0 : -1;
}

export function SegmentedControl<T extends string>(props: {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-required"?: boolean | "false" | "true";
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
  options: readonly SelectionOption<T>[];
  value: T;
}) {
  return (
    <div
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      aria-label={props.label}
      aria-required={props["aria-required"]}
      className="segmented-control"
      role="radiogroup"
    >
      {props.options.map((option, index) => (
        <button
          aria-checked={props.value === option.value}
          disabled={props.disabled || option.disabled}
          key={option.value}
          onClick={() => props.onChange(option.value)}
          onKeyDown={(event) => handleRadioGroupKeyDown(event, props.options, index, props.onChange)}
          role="radio"
          tabIndex={radioTabIndex(props.options, props.value, index, props.disabled)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ChoiceGroup<T extends string>(props: {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-required"?: boolean | "false" | "true";
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
  options: readonly SelectionOption<T>[];
  value: T;
}) {
  const optionIdPrefix = useId();

  return (
    <div
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      aria-label={props.label}
      aria-required={props["aria-required"]}
      className="ui-choice-group"
      role="radiogroup"
    >
      {props.options.map((option, index) => {
        const selected = props.value === option.value;
        const labelId = `${optionIdPrefix}-${index}-label`;
        const descriptionId = option.description ? `${optionIdPrefix}-${index}-description` : undefined;
        return (
          <button
            aria-checked={selected}
            aria-describedby={descriptionId}
            aria-labelledby={labelId}
            className={classNames("ui-choice-card", selected && "ui-choice-card--selected")}
            disabled={props.disabled || option.disabled}
            key={option.value}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => handleRadioGroupKeyDown(event, props.options, index, props.onChange)}
            role="radio"
            tabIndex={radioTabIndex(props.options, props.value, index, props.disabled)}
            type="button"
          >
            <span className="ui-choice-card__copy">
              <strong id={labelId}>{option.label}</strong>
              {option.description && <small id={descriptionId}>{option.description}</small>}
            </span>
            <span aria-hidden="true" className="ui-choice-card__radio">
              {selected && <span className="ui-choice-card__radio-dot" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ChoicePills<T extends string>(props: {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-required"?: boolean | "false" | "true";
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
  options: readonly SelectionOption<T>[];
  value: T;
}) {
  return (
    <div
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      aria-label={props.label}
      aria-required={props["aria-required"]}
      className="ui-choice-pills"
      role="radiogroup"
    >
      {props.options.map((option, index) => (
        <button
          aria-checked={props.value === option.value}
          disabled={props.disabled || option.disabled}
          key={option.value}
          onClick={() => props.onChange(option.value)}
          onKeyDown={(event) => handleRadioGroupKeyDown(event, props.options, index, props.onChange)}
          role="radio"
          tabIndex={radioTabIndex(props.options, props.value, index, props.disabled)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SplitView(props: {
  detail: ReactNode;
  label: string;
  sidebar: ReactNode;
  sidebarWidth?: string;
}) {
  return (
    <section
      aria-label={props.label}
      className="ui-split-view"
      style={{ "--split-sidebar-width": props.sidebarWidth } as CSSProperties}
    >
      <div className="ui-split-view__sidebar">{props.sidebar}</div>
      <div className="ui-split-view__detail">{props.detail}</div>
    </section>
  );
}
