import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
  secondary:
    'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
  success: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-3.5 py-2 text-sm', lg: 'px-5 py-3 text-base' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-slate-900 ${sizes[size]} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function LinkButton({
  href,
  children,
  variant = 'secondary',
  download,
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
  download?: boolean;
}) {
  return (
    <a
      href={href}
      download={download}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${VARIANTS[variant]}`}
    >
      {children}
    </a>
  );
}

export function Card({
  children,
  className = '',
  title,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={`rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800 ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100 dark:bg-brand-700/25 dark:text-brand-100 dark:ring-brand-700/40',
  green:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:ring-emerald-800',
  amber:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:ring-amber-800',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-900/40 dark:text-red-300 dark:ring-red-800',
  violet:
    'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:ring-violet-800',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({
  tone = 'gray',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'error' | 'success';
  title?: string;
  children?: ReactNode;
}) {
  const tones = {
    info: 'bg-brand-50 text-brand-800 ring-brand-100 dark:bg-brand-700/20 dark:text-brand-100 dark:ring-brand-700/40',
    warn: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:ring-amber-800',
    error:
      'bg-red-50 text-red-900 ring-red-200 dark:bg-red-900/30 dark:text-red-200 dark:ring-red-800',
    success:
      'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:ring-emerald-800',
  };
  return (
    <div
      className={`rounded-lg px-4 py-3 text-sm ring-1 ring-inset ${tones[tone]}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
    </div>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-12 text-center">
      <div className="text-sm font-medium text-slate-700 dark:text-slate-300">{title}</div>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <div className="mt-1">{children(id)}</div>
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputCls =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-500 disabled:opacity-60 dark:bg-slate-950 dark:text-slate-100 dark:ring-slate-700';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input className={`${inputCls} ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={`${inputCls} pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? 'left-4.5' : 'left-0.5'}`}
        />
      </button>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </label>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={ref}
        className={`relative w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl bg-white shadow-xl ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800`}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-950/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}

export function Stat({
  label,
  value,
  tone = 'gray',
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
}) {
  const accent = {
    gray: 'text-slate-900 dark:text-slate-100',
    blue: 'text-brand-600 dark:text-brand-100',
    green: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
    violet: 'text-violet-600 dark:text-violet-400',
  }[tone];
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${accent}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 -my-5 overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = '',
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`px-4 py-2.5 align-top ${className}`}>
      {children}
    </td>
  );
}
