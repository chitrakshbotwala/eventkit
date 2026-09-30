import { useEffect, useRef, useState } from 'react';
import { ek, useLogs } from '../lib/hooks';
import { Button } from './ui';

const LEVEL_COLOR = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-amber-300',
  error: 'text-red-400',
};

export function LogDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lines = useLogs(open);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  if (!open) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 flex h-[45%] flex-col border-t border-slate-700 bg-slate-950 shadow-2xl">
      <div className="flex items-center justify-between px-4 py-2 text-sm text-slate-300">
        <span className="font-medium">Live log</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{' '}
            follow
          </label>
          <Button variant="ghost" onClick={() => void ek.logs.openFolder()}>
            Open log folder
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div
        ref={ref}
        className="selectable min-h-0 flex-1 overflow-y-auto px-4 pb-3 font-mono text-[11px] leading-relaxed"
      >
        {lines.map((l, i) => (
          <div key={`${l.t}-${i}`} className={LEVEL_COLOR[l.level]}>
            <span className="text-slate-600">{new Date(l.t).toLocaleTimeString()} </span>
            <span className="text-slate-500">[{l.scope}] </span>
            {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
