import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import {
  Shield, RefreshCw, Settings, Bell, TrendingUp,
  AlertTriangle, X, Target, BarChart2, BookOpen, Loader2,
  Fingerprint, Lock, KeyRound, Clock, Trash2, CalendarDays,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  premium_ratio: number;  // 0-3
  buffer: number;         // 0-2
  liquidity: number;      // 0-2
  dte: number;            // 0-2
  iv: number;             // 0-1
}

interface Play {
  id: number;
  symbol: string;
  play_type: string;
  short_strike: number;
  long_strike: number;
  expiration: string;
  dte: number;
  current_price: number;
  net_credit: number;
  max_risk: number;
  spread_width: number;
  buffer_pct: number;
  score: number;
  score_breakdown?: string; // JSON string from DB
  volume: number;
  open_interest: number;
  iv: number;
  found_at: string;
  is_active: number;
  ai_analysis?: string;
}

interface Position {
  id: number;
  symbol: string;
  short_strike: number;
  long_strike: number;
  expiration: string;
  dte_at_entry: number;
  entry_price: number;
  entry_credit: number;
  contracts: number;
  max_risk: number;
  buffer_pct_at_entry: number;
  score_at_entry: number;
  entry_notes?: string;
  tracked_at: string;
  current_mid?: number;
  current_price?: number;
  pnl_pct?: number;
  last_updated?: string;
  status: 'open' | 'closed';
  exit_credit?: number;
  exit_reason?: string;
  closed_at?: string;
}

interface Alert {
  id: number;
  position_id: number;
  alert_type: 'profit' | 'loss';
  message: string;
  triggered_at: string;
  acknowledged: number;
  symbol?: string;
}

interface Recommendation {
  recommendation: 'hold' | 'caution' | 'exit';
  summary: string;
  rsi: number | null;
  current_price: number;
  buffer_pct: number;
  reasons: string[];
  exit_signals: number;
}

interface BotStatus {
  status: string;
  plays_available: number;
  open_positions: number;
  unread_alerts: number;
  scanning: boolean;
  market_open: boolean;
}

type Tab = 'plays' | 'positions' | 'history' | 'alerts' | 'earnings';

// ─── API ─────────────────────────────────────────────────────────────────────

function getBase(): string {
  return 'https://fortress-options.onrender.com';
}

function getApiKey(): string {
  return localStorage.getItem('fortress_api_key') || '';
}

async function apiFetch(path: string, opts?: RequestInit) {
  const key = getApiKey();
  const headers: Record<string, string> = {
    ...(opts?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts?.headers as Record<string, string> || {}),
    ...(key ? { 'X-API-Key': key } : {}),
  };
  const res = await fetch(`${getBase()}${path}`, { ...opts, headers });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j?.detail || j?.message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ─── Market hours helpers ─────────────────────────────────────────────────────

/** Returns ET hour + minute as fractional hours (e.g. 9.5 = 9:30 AM ET). */
function etHour(): number {
  const now = new Date();
  // Intl gives us the wall-clock time in ET without depending on the host TZ
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return h + m / 60;
}

function etWeekday(): number {
  const now = new Date();
  // Create a Date parsed from ET local time string to get the correct day-of-week
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return etDate.getDay(); // 0=Sun … 6=Sat
}

/** True if the US equity market is currently open (Mon–Fri 9:30–16:00 ET). */
function isMarketOpen(): boolean {
  const wd = etWeekday();
  if (wd === 0 || wd === 6) return false;
  const h = etHour();
  return h >= 9.5 && h < 16;
}

/**
 * True if we're in the first 30 minutes after market open (9:30–10:00 ET) —
 * the "market settling" window where plays are actively being scanned.
 */
function isMarketJustOpened(): boolean {
  const wd = etWeekday();
  if (wd === 0 || wd === 6) return false;
  const h = etHour();
  return h >= 9.5 && h < 10.0;
}

// ─── App version ─────────────────────────────────────────────────────────────
const CURRENT_VERSION = (import.meta.env.VITE_APP_VERSION as string) || '2.4.0';

// ─── Desktop detection ───────────────────────────────────────────────────────
const IS_ELECTRON = !!window.electronAPI?.isElectron;

// ─── Tablet detection ─────────────────────────────────────────────────────────
function useIsTablet() {
  const [isTablet, setIsTablet] = useState(() => window.innerWidth >= 1024);
  useEffect(() => {
    const update = () => setIsTablet(window.innerWidth >= 1024);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return isTablet;
}

// ─── Theme ───────────────────────────────────────────────────────────────────
const ThemeContext = createContext<{ dark: boolean; toggle: () => void }>({ dark: true, toggle: () => {} });
const useTheme = () => useContext(ThemeContext);

// ─── Shared Components ────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const isHot = score >= 8;
  const cls =
    score >= 8 ? 'bg-emerald-500 text-black'
    : score >= 6 ? 'bg-yellow-400 text-black'
    : score >= 4 ? 'bg-orange-400 text-black'
    : 'bg-red-500 text-white';
  return (
    <span
      className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${cls} ${isHot ? 'animate-pulse shadow-[0_0_10px_2px_rgba(16,185,129,0.7)]' : ''}`}
      style={isHot ? { boxShadow: '0 0 10px 2px rgba(16,185,129,0.75)' } : undefined}
    >
      {score}/10
    </span>
  );
}

function StatPill({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="text-center">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-semibold ${dim ? 'text-zinc-400' : 'text-zinc-100'}`}>{value}</p>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const closedByBackRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Push a history entry so Android hardware back button triggers popstate
    history.pushState({ fortress_modal: Date.now() }, '');

    const handlePop = () => {
      closedByBackRef.current = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', handlePop);

    return () => {
      window.removeEventListener('popstate', handlePop);
      // If modal was closed by X/backdrop (not back button), pop our history entry
      if (!closedByBackRef.current) {
        history.back();
      }
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, y: 48 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 48 }}
        transition={{ type: 'spring', damping: 24, stiffness: 300 }}
        className="w-full max-w-md bg-[#1C1C1E] border border-zinc-700/60 rounded-3xl shadow-2xl overflow-hidden"
      >
        {children}
      </motion.div>
    </div>
  );
}

// ─── Play Card ────────────────────────────────────────────────────────────────

function formatExpiration(dateStr: string, dte: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  const num = d.getDate();
  return `${day} ${mon} ${num}  ·  ${dte}d`;
}

function formatFoundAt(ts: string): string {
  if (!ts) return '';
  // Postgres stores found_at as "2026-04-29 12:34:56.789+00" — space-separated,
  // short timezone offset. Normalize to strict ISO so new Date() doesn't return
  // "Invalid Date" on WebKit/Android WebView.
  let iso = ts.replace(' ', 'T');                        // space → T
  iso = iso.replace(/([+-]\d{2})$/, '$1:00');            // +00 → +00:00
  if (!iso.includes('Z') && !/[+-]\d{2}:\d{2}/.test(iso)) iso += 'Z'; // bare SQLite → UTC
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function RobinhoodButton({ play }: { play: Play }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'open'>('idle');

  const handleTrade = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const typeLabel =
      play.play_type === 'bear_call' ? 'Bear Call Spread' :
      play.play_type === 'bull_put'  ? 'Bull Put Spread'  : 'Iron Condor';
    const expFmt = formatExpiration(play.expiration, play.dte);
    const details =
      `${play.symbol} $${play.short_strike}/$${play.long_strike} ${typeLabel} | ` +
      `$${play.net_credit.toFixed(2)} credit | Exp ${expFmt} | Score ${play.score}/10`;

    if (window.electronAPI) {
      // Desktop: open embedded Robinhood split-panel; main process copies to clipboard
      setState('open');
      await window.electronAPI.openRobinhood(play.symbol, details);
    } else {
      // Mobile / web: copy details to clipboard then open Robinhood in browser/app
      try { await navigator.clipboard.writeText(details); } catch {}
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
      const url = `https://robinhood.com/options/${encodeURIComponent(play.symbol)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await window.electronAPI?.closeRobinhood();
    setState('idle');
  };

  if (state === 'open' && window.electronAPI) {
    return (
      <button
        onClick={handleClose}
        className="flex-none flex items-center gap-1 px-3 py-3 rounded-xl text-xs font-semibold transition-colors border border-red-500/40 text-red-400 hover:bg-red-500/10"
        title="Close Robinhood panel"
      >
        ✕ Close RH
      </button>
    );
  }

  return (
    <button
      onClick={handleTrade}
      className="flex-none flex items-center gap-1 px-3 py-3 rounded-xl text-xs font-semibold transition-colors border border-[#00c805]/40 text-[#00c805] hover:bg-[#00c805]/10 active:bg-[#00c805]/20"
      title="Copy trade details and open Robinhood"
    >
      {state === 'copied' ? '✓ Copied' : '🟢 Trade'}
    </button>
  );
}

function PlayCard({ play, onTrack, onViewReasoning }: { play: Play; onTrack: (p: Play) => void; onViewReasoning: (p: Play) => void }) {
  const returnPct = ((play.net_credit / play.spread_width) * 100).toFixed(1);
  const isHotCard = play.score >= 8;
  const isBearCall = play.play_type === 'bear_call';
  const isIronCondor = play.play_type === 'iron_condor';
  const bd = play.score_breakdown ? JSON.parse(play.score_breakdown) : {};

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-[#161618] rounded-2xl p-4 cursor-pointer active:scale-[0.99] transition-all ${
        isHotCard
          ? 'border border-emerald-500/50 shadow-[0_0_24px_rgba(16,185,129,0.22)]'
          : 'border border-zinc-800/80'
      }`}
      style={isHotCard ? { boxShadow: '0 0 28px rgba(16,185,129,0.18), 0 0 0 1px rgba(16,185,129,0.3)' } : undefined}
      onClick={() => onViewReasoning(play)}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xl font-bold text-white">{play.symbol}</span>
            <ScoreBadge score={play.score} />
            {play.is_active === 1 ? (
              <span className="text-[10px] text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full font-medium">Latest</span>
            ) : (
              <span className="text-[10px] text-zinc-500 bg-zinc-800 border border-zinc-700/50 px-2 py-0.5 rounded-full font-medium">Earlier Today</span>
            )}
            {isBearCall && (
              <span className="text-[10px] text-sky-400 bg-sky-400/10 border border-sky-400/20 px-2 py-0.5 rounded-full font-medium">Bear Call</span>
            )}
            {isIronCondor && (
              <span className="text-[10px] text-purple-400 bg-purple-400/10 border border-purple-400/20 px-2 py-0.5 rounded-full font-medium">Iron Condor</span>
            )}
            {play.play_type === 'earnings' && (
              <span className="text-[10px] text-orange-400 bg-orange-400/10 border border-orange-400/20 px-2 py-0.5 rounded-full font-medium">Earnings</span>
            )}
          </div>
          <p className="text-sm text-zinc-500 mt-0.5">${play.current_price.toFixed(2)} current</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-emerald-400">${play.net_credit.toFixed(2)}</p>
          <p className="text-[10px] text-zinc-500">per share</p>
        </div>
      </div>

      {/* Expiration + scan timestamp */}
      <div className="flex items-center justify-between bg-zinc-900 border border-zinc-700/50 rounded-xl px-3 py-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Expires</span>
          <span className="text-sm font-semibold text-white">{formatExpiration(play.expiration, play.dte)}</span>
        </div>
        {play.found_at && (
          <div className="flex items-center gap-1 bg-zinc-800 rounded-lg px-2 py-0.5">
            <Clock className="w-2.5 h-2.5 text-emerald-500" />
            <span className="text-[11px] font-medium text-zinc-300">{formatFoundAt(play.found_at)}</span>
          </div>
        )}
      </div>

      <div className="bg-zinc-900/60 rounded-xl p-3 mb-3 space-y-1.5">
        {isIronCondor ? (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Sell put / buy put</span>
              <span className="font-mono font-semibold text-emerald-400">${play.short_strike} / ${bd.put_long ?? (play.short_strike - 5)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Sell call / buy call</span>
              <span className="font-mono font-semibold text-sky-400">${bd.call_short ?? play.long_strike} / ${bd.call_long ?? (play.long_strike + 5)}</span>
            </div>
            <div className="flex justify-between text-[11px] text-zinc-500 pt-0.5 border-t border-zinc-700/40">
              <span>Profit zone</span>
              <span className="text-purple-300">${play.short_strike} – ${play.long_strike}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Sell (short {isBearCall ? 'call' : 'put'})</span>
              <span className={`font-mono font-semibold ${isBearCall ? 'text-red-400' : 'text-emerald-400'}`}>
                ${play.short_strike} {isBearCall ? 'Call' : 'Put'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Buy (long {isBearCall ? 'call' : 'put'})</span>
              <span className={`font-mono font-semibold ${isBearCall ? 'text-orange-400' : 'text-red-400'}`}>
                ${play.long_strike} {isBearCall ? 'Call' : 'Put'}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-x-2 gap-y-2 mb-4">
        <StatPill label="Buffer" value={`${play.buffer_pct.toFixed(1)}%`} />
        <StatPill label="Return" value={`${returnPct}%`} />
        <StatPill label="Max Risk" value={`$${play.max_risk.toFixed(0)}`} />
        <StatPill label="IV" value={`${(play.iv * 100).toFixed(0)}%`} dim />
        <StatPill label="Volume" value={`${play.volume || 0}`} dim />
        <StatPill label="OI" value={`${play.open_interest || 0}`} dim />
      </div>

      <div className="flex gap-2">
        <button
          onClick={e => { e.stopPropagation(); onViewReasoning(play); }}
          className="flex-none px-3 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold rounded-xl transition-colors border border-zinc-700/50"
        >
          Why?
        </button>
        <RobinhoodButton play={play} />
        <button
          onClick={e => { e.stopPropagation(); onTrack(play); }}
          className={`flex-1 py-3 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-black font-bold text-sm rounded-xl transition-colors ${play.score >= 8 ? 'animate-pulse shadow-[0_0_16px_4px_rgba(16,185,129,0.6)]' : ''}`}
          style={play.score >= 8 ? { boxShadow: '0 0 18px 5px rgba(16,185,129,0.55)' } : undefined}
        >
          {play.score >= 8 ? '🔥 Track Trade' : 'Track Trade'}
        </button>
      </div>
    </motion.div>
  );
}

// ─── Position Card ────────────────────────────────────────────────────────────

function PositionCard({
  pos,
  onRecommend,
  onClose,
}: {
  pos: Position;
  onRecommend: (p: Position) => void;
  onClose: (p: Position) => void;
}) {
  const pnl = pos.pnl_pct ?? 0;
  const profitTarget = Number(localStorage.getItem('fortress_profit_target') || '50');
  const hitTarget = pnl >= profitTarget;
  const pnlColor =
    pnl >= 30 ? 'text-emerald-300'
    : pnl >= 10 ? 'text-green-400'
    : pnl >= 0 ? 'text-zinc-200'
    : pnl >= -10 ? 'text-yellow-400'
    : 'text-red-400';
  const borderColor =
    pnl >= 20 ? 'border-emerald-500/30' : pnl <= -10 ? 'border-red-500/30' : 'border-zinc-800/80';
  const barColor =
    pnl >= 50 ? 'bg-emerald-500' : pnl >= 20 ? 'bg-yellow-400' : pnl >= 0 ? 'bg-blue-500' : 'bg-red-500';
  const progress = Math.max(0, Math.min(100, pnl));

  const expDate = new Date(pos.expiration);
  const dteLeft = Math.max(0, Math.floor((expDate.getTime() - Date.now()) / 86_400_000));

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-[#161618] border ${borderColor} rounded-2xl p-4`}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-white">{pos.symbol}</span>
            {hitTarget && (
              <span className="text-[10px] font-bold text-emerald-400 bg-emerald-400/15 border border-emerald-400/30 px-2 py-0.5 rounded-full animate-pulse">
                🎯 Target!
              </span>
            )}
          </div>
          <p className="text-sm text-zinc-400">
            ${pos.short_strike}/{pos.long_strike} {pos.play_type === 'bear_call' ? 'Call' : pos.play_type === 'iron_condor' ? 'Iron Condor' : 'Put'} Spread
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {pos.expiration} · {dteLeft}d left · {pos.contracts}x
          </p>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-bold ${pnlColor}`}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%
          </p>
          <p className="text-[10px] text-zinc-500">P&L</p>
        </div>
      </div>

      <div className="mb-3">
        <div className="flex justify-between text-[11px] text-zinc-500 mb-1">
          <span>Progress to max profit</span>
          <span>{Math.max(0, pnl).toFixed(0)}% / 100%</span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <StatPill label="Entry" value={`$${pos.entry_credit.toFixed(2)}`} />
        <StatPill label="Current Mid" value={pos.current_mid != null ? `$${pos.current_mid.toFixed(2)}` : '—'} />
        <StatPill label="Underlying" value={pos.current_price != null ? `$${pos.current_price.toFixed(2)}` : '—'} />
      </div>

      {pos.last_updated && (
        <p className="text-[10px] text-zinc-600 mb-2 text-right">
          Updated {pos.last_updated.slice(11, 16)}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => onRecommend(pos)}
          className="flex-1 py-2.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-zinc-200 text-sm font-medium rounded-xl transition-colors"
        >
          Should I Exit?
        </button>
        <button
          onClick={() => onClose(pos)}
          className="flex-1 py-2.5 bg-red-500/15 hover:bg-red-500/25 active:bg-red-500/10 text-red-400 text-sm font-medium rounded-xl transition-colors border border-red-500/20"
        >
          Close Trade
        </button>
      </div>
    </motion.div>
  );
}

// ─── History Row ─────────────────────────────────────────────────────────────

function HistoryRow({ pos }: { pos: Position }) {
  const pnl = pos.pnl_pct ?? 0;
  const win = pnl >= 30; // Win = captured ≥30% of max profit
  return (
    <div className="bg-[#161618] border border-zinc-800/80 rounded-xl p-3.5 flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">{pos.symbol}</span>
          <span className="text-xs text-zinc-500">${pos.short_strike}/{pos.long_strike}</span>
        </div>
        <p className="text-xs text-zinc-500 mt-0.5">
          {pos.exit_reason || 'closed'} · {pos.closed_at?.slice(0, 10) ?? ''}
        </p>
      </div>
      <div className="text-right">
        <p className={`font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%
        </p>
        <p className="text-[10px] mt-0.5">{win ? '✅ Win' : pnl >= 0 ? '🟡 Partial' : '❌ Loss'}</p>
        <p className="text-[11px] text-zinc-500">
          ${pos.entry_credit.toFixed(2)} → ${pos.exit_credit?.toFixed(2) ?? '?'}
        </p>
      </div>
    </div>
  );
}

// ─── Alert Row ────────────────────────────────────────────────────────────────

function AlertRow({ alert, onAck, onDelete }: { alert: Alert; onAck: (id: number) => void; onDelete: (id: number) => void }) {
  const isProfit = alert.alert_type === 'profit';
  return (
    <div
      className={`bg-[#161618] border rounded-xl p-3.5 ${
        isProfit ? 'border-emerald-500/25' : 'border-red-500/25'
      } ${alert.acknowledged ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
          {isProfit ? <TrendingUp className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-bold mb-0.5 ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
            {isProfit ? 'PROFIT TARGET HIT' : 'LOSS WARNING'}
          </p>
          <p className="text-sm text-zinc-200 leading-snug">{alert.message}</p>
          <p className="text-[10px] text-zinc-600 mt-1">
            {alert.triggered_at.slice(0, 16).replace('T', ' ')}
          </p>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {!alert.acknowledged && (
            <button
              onClick={() => onAck(alert.id)}
              className="p-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              title="Mark read"
            >
              <X className="w-3.5 h-3.5 text-zinc-400" />
            </button>
          )}
          <button
            onClick={() => onDelete(alert.id)}
            className="p-1.5 bg-red-500/10 hover:bg-red-500/25 rounded-lg transition-colors"
            title="Delete alert"
          >
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Track Modal ──────────────────────────────────────────────────────────────

function TrackModal({
  play,
  onConfirm,
  onClose,
}: {
  play: Play;
  onConfirm: (contracts: number, notes: string) => void;
  onClose: () => void;
}) {
  const [contracts, setContracts] = useState(1);
  const [notes, setNotes] = useState('');
  const totalCredit = (play.net_credit * 100 * contracts).toFixed(0);
  const totalRisk = (play.max_risk * contracts).toFixed(0);

  return (
    <Modal onClose={onClose}>
      <div className="p-6">
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-bold text-white">Track This Trade</h3>
          <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        <div className="bg-zinc-900 rounded-2xl p-4 mb-5">
          <div className="flex justify-between items-start mb-3">
            <div>
              <p className="text-lg font-bold text-white">{play.symbol}</p>
              <p className="text-sm text-zinc-400">
                ${play.short_strike} / ${play.long_strike} Put · {play.expiration}
              </p>
            </div>
            <ScoreBadge score={play.score} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] text-zinc-500 uppercase">Credit / Contract</p>
              <p className="font-bold text-emerald-400">${(play.net_credit * 100).toFixed(0)}</p>
            </div>
            <div>
              <p className="text-[10px] text-zinc-500 uppercase">Max Risk / Contract</p>
              <p className="font-bold text-red-400">${play.max_risk.toFixed(0)}</p>
            </div>
          </div>
        </div>

        <p className="text-sm text-zinc-400 mb-2">Contracts</p>
        <div className="flex items-center justify-center gap-6 mb-4">
          <button
            onClick={() => setContracts(Math.max(1, contracts - 1))}
            className="w-11 h-11 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 rounded-2xl text-white text-xl font-bold transition-colors"
          >
            −
          </button>
          <span className="text-4xl font-bold text-white w-12 text-center">{contracts}</span>
          <button
            onClick={() => setContracts(contracts + 1)}
            className="w-11 h-11 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 rounded-2xl text-white text-xl font-bold transition-colors"
          >
            +
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4 bg-zinc-900 rounded-xl p-3">
          <div className="text-center">
            <p className="text-[10px] text-zinc-500 uppercase">Cash Collected</p>
            <p className="text-lg font-bold text-emerald-400">${totalCredit}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-zinc-500 uppercase">Total Max Risk</p>
            <p className="text-lg font-bold text-red-400">${totalRisk}</p>
          </div>
        </div>

        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 mb-4 focus:outline-none focus:border-emerald-500"
        />

        <button
          onClick={() => onConfirm(contracts, notes)}
          className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-black font-bold rounded-xl transition-colors"
        >
          Add to Tracker
        </button>
      </div>
    </Modal>
  );
}

// ─── P&L Payoff Chart ────────────────────────────────────────────────────────

function PayoffChart({ play }: { play: Play }) {
  const W = 280, H = 80;
  const price = play.current_price;
  const credit = play.net_credit;
  const sw = SPREAD_WIDTH_CONST; // always 5
  const maxProfit = credit * 100;
  const maxLoss = (sw - credit) * 100;

  // For bull_put: profit above short_strike, loss below long_strike
  // For bear_call: profit below short_strike, loss above long_strike
  // For iron_condor: profit between short_strike and long_strike
  const isBear = play.play_type === 'bear_call';
  const isCondor = play.play_type === 'iron_condor';

  // Price range to display: 15% below and above current price
  const range = price * 0.18;
  const priceMin = price - range;
  const priceMax = price + range;

  // Map price → x pixel
  const px = (p: number) => ((p - priceMin) / (priceMax - priceMin)) * W;

  // Generate pnl curve points
  const points: [number, number][] = [];
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const p = priceMin + (i / steps) * (priceMax - priceMin);
    let pnl = 0;
    if (isCondor) {
      const bd = play.score_breakdown ? JSON.parse(play.score_breakdown) : {};
      const putLong = bd.put_long ?? (play.short_strike - sw);
      const callLong = bd.call_long ?? (play.long_strike + sw);
      const putShort = play.short_strike;
      const callShort = play.long_strike;
      if (p >= putShort && p <= callShort) pnl = maxProfit;
      else if (p < putShort && p > putLong) pnl = ((p - putLong) / sw) * maxProfit - maxProfit + maxProfit;
      else if (p > callShort && p < callLong) pnl = ((callLong - p) / sw) * maxProfit - maxProfit + maxProfit;
      else pnl = -maxLoss;
    } else if (isBear) {
      const callShort = play.short_strike;
      const callLong = play.long_strike;
      if (p <= callShort) pnl = maxProfit;
      else if (p >= callLong) pnl = -maxLoss;
      else pnl = maxProfit - ((p - callShort) / sw) * (maxProfit + maxLoss);
    } else {
      const putShort = play.short_strike;
      const putLong = play.long_strike;
      if (p >= putShort) pnl = maxProfit;
      else if (p <= putLong) pnl = -maxLoss;
      else pnl = -maxLoss + ((p - putLong) / sw) * (maxProfit + maxLoss);
    }
    points.push([px(p), pnl]);
  }

  // Map pnl → y pixel (profit at top, loss at bottom)
  const totalRange = maxProfit + maxLoss;
  const py = (pnl: number) => H - ((pnl + maxLoss) / totalRange) * H;
  const zeroY = py(0);

  // Build SVG polyline
  const polyline = points.map(([x, pnl]) => `${x.toFixed(1)},${py(pnl).toFixed(1)}`).join(' ');

  // Split into profit (green) and loss (red) segments
  const profitPts = points.filter(([, pnl]) => pnl >= 0).map(([x, pnl]) => `${x.toFixed(1)},${py(pnl).toFixed(1)}`).join(' ');

  return (
    <div className="bg-zinc-900/60 rounded-xl p-3 mb-4">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-2">P&amp;L at Expiration</p>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        {/* Zero line */}
        <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#3f3f46" strokeWidth="1" strokeDasharray="3,3" />
        {/* Loss fill */}
        <polyline points={polyline} fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.7" />
        {/* Profit fill */}
        <polyline points={polyline} fill="none" stroke="#10b981" strokeWidth="2" opacity="0.9"
          strokeDasharray="none"
          style={{ clipPath: `inset(0 0 ${H - zeroY}px 0)` }}
        />
        {/* Current price line */}
        <line x1={px(price)} y1="0" x2={px(price)} y2={H} stroke="#a1a1aa" strokeWidth="1" strokeDasharray="4,2" />
        <text x={px(price) + 3} y="10" fill="#a1a1aa" fontSize="8">Now</text>
        {/* Labels */}
        <text x="2" y="10" fill="#10b981" fontSize="8">+${maxProfit.toFixed(0)}</text>
        <text x="2" y={H - 2} fill="#ef4444" fontSize="8">-${maxLoss.toFixed(0)}</text>
      </svg>
    </div>
  );
}

const SPREAD_WIDTH_CONST = 5;

// ─── Recommend Modal ──────────────────────────────────────────────────────────

// ─── Play Reasoning Modal ─────────────────────────────────────────────────────

function PlayReasoningModal({ play, onClose, onTrack }: { play: Play; onClose: () => void; onTrack: (p: Play) => void }) {
  const bd: ScoreBreakdown = play.score_breakdown
    ? JSON.parse(play.score_breakdown)
    : { premium_ratio: 0, buffer: 0, liquidity: 0, dte: 0, iv: 0 };

  const returnPct = ((play.net_credit / play.spread_width) * 100).toFixed(1);
  const isHot = play.score >= 8;
  const isBearCall = play.play_type === 'bear_call';

  const categories = [
    {
      label: 'Premium Quality',
      key: 'premium_ratio' as keyof ScoreBreakdown,
      max: 3,
      icon: '💰',
      value: bd.premium_ratio,
      desc: bd.premium_ratio === 3
        ? `${returnPct}% return — excellent premium for the risk`
        : bd.premium_ratio === 2
        ? `${returnPct}% return — solid credit collected`
        : bd.premium_ratio === 1
        ? `${returnPct}% return — acceptable but tighter than ideal`
        : `${returnPct}% return — low premium, higher risk/reward ratio`,
    },
    {
      label: 'Safety Buffer',
      key: 'buffer' as keyof ScoreBreakdown,
      max: 2,
      icon: '🛡️',
      value: bd.buffer,
      desc: bd.buffer === 2
        ? `${play.buffer_pct.toFixed(1)}% ${isBearCall ? 'above' : 'below'} current price — strong ${isBearCall ? 'upside' : 'downside'} cushion`
        : bd.buffer === 1
        ? `${play.buffer_pct.toFixed(1)}% ${isBearCall ? 'above' : 'below'} current price — moderate buffer`
        : `${play.buffer_pct.toFixed(1)}% ${isBearCall ? 'above' : 'below'} current price — tight, needs close watch`,
    },
    {
      label: 'Liquidity',
      key: 'liquidity' as keyof ScoreBreakdown,
      max: 2,
      icon: '🌊',
      value: bd.liquidity,
      desc: bd.liquidity === 2
        ? `Vol ${play.volume} · OI ${play.open_interest} — highly liquid, easy fills`
        : bd.liquidity === 1
        ? `Vol ${play.volume} · OI ${play.open_interest} — decent liquidity`
        : `Vol ${play.volume} · OI ${play.open_interest} — thin market, expect wider spreads`,
    },
    {
      label: 'Days to Expiry',
      key: 'dte' as keyof ScoreBreakdown,
      max: 2,
      icon: '📅',
      value: bd.dte,
      desc: bd.dte === 2
        ? `${play.dte} DTE — sweet spot for theta decay (9-12 days)`
        : bd.dte === 1
        ? `${play.dte} DTE — acceptable range for premium selling`
        : `${play.dte} DTE — outside optimal theta decay window`,
    },
    {
      label: 'Implied Volatility',
      key: 'iv' as keyof ScoreBreakdown,
      max: 1,
      icon: '📊',
      value: bd.iv,
      desc: bd.iv === 1
        ? `IV ${(play.iv * 100).toFixed(0)}% — elevated IV means richer premium to sell`
        : `IV ${(play.iv * 100).toFixed(0)}% — below 20%, premium is thinner`,
    },
  ];

  const verdictColor = play.score >= 8 ? 'text-emerald-400' : play.score >= 6 ? 'text-yellow-400' : 'text-orange-400';
  const verdict = play.score >= 8
    ? 'Strong setup — all key factors align'
    : play.score >= 6
    ? 'Good play — most criteria met'
    : play.score >= 4
    ? 'Moderate — some trade-offs present'
    : 'Weak signal — proceed with caution';

  return (
    <Modal onClose={onClose}>
      <div className="flex flex-col max-h-[88vh] overflow-hidden">
        {/* Sticky header — always visible even when content scrolls */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0 bg-[#1C1C1E] rounded-t-3xl">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-bold text-white">{play.symbol}</h3>
              <ScoreBadge score={play.score} />
              {play.play_type === 'iron_condor' && (
                <span className="text-[10px] text-purple-400 bg-purple-400/10 border border-purple-400/20 px-2 py-0.5 rounded-full font-medium">Iron Condor</span>
              )}
              {play.play_type === 'earnings' && (
                <span className="text-[10px] text-orange-400 bg-orange-400/10 border border-orange-400/20 px-2 py-0.5 rounded-full font-medium">Earnings</span>
              )}
            </div>
            <p className="text-xs text-zinc-500 mt-0.5">
              {play.play_type === 'iron_condor'
                ? `$${play.short_strike}/$${play.long_strike} Iron Condor · $${play.net_credit.toFixed(2)} combined credit`
                : `$${play.short_strike}/$${play.long_strike} ${isBearCall ? 'Call Spread' : 'Put Spread'} · $${play.net_credit.toFixed(2)} credit`}
            </p>
          </div>
          <button onClick={onClose} className="p-2 bg-zinc-800 rounded-xl active:bg-zinc-700">
            <X className="w-5 h-5 text-zinc-300" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0 px-5 pb-5">

        {/* Verdict */}
        <div className={`flex items-center gap-2 bg-zinc-900 rounded-xl px-3 py-2.5 mb-4 border ${isHot ? 'border-emerald-500/30' : 'border-zinc-700/50'}`}>
          <span className="text-lg">{isHot ? '🔥' : '📋'}</span>
          <p className={`text-sm font-semibold ${verdictColor}`}>{verdict}</p>
        </div>

        {/* AI Analysis */}
        {play.ai_analysis && (
          <div className="bg-zinc-900/80 border border-emerald-500/20 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-base">🤖</span>
              <span className="text-xs font-bold uppercase tracking-widest text-emerald-400">Fortress AI Analysis</span>
            </div>
            <div className="space-y-3 text-[12px] text-zinc-300 leading-relaxed">
              {play.ai_analysis.split('\n\n').map((block, i) => {
                const lines = block.split('\n');
                const heading = lines[0].replace(/\*\*/g, '');
                const body = lines.slice(1).join(' ');
                return (
                  <div key={i}>
                    <p className="font-bold text-zinc-100 mb-0.5">{heading}</p>
                    {body && <p className="text-zinc-400">{body}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Score breakdown */}
        <div className="space-y-3 mb-4">
          {categories.map(cat => (
            <div key={cat.key} className="bg-zinc-900/60 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">{cat.icon}</span>
                  <span className="text-xs font-semibold text-zinc-200">{cat.label}</span>
                </div>
                <span className={`text-xs font-bold ${cat.value === cat.max ? 'text-emerald-400' : cat.value > 0 ? 'text-yellow-400' : 'text-zinc-500'}`}>
                  {cat.value}/{cat.max}
                </span>
              </div>
              {/* Bar */}
              <div className="flex gap-0.5 mb-1.5">
                {Array.from({ length: cat.max }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full ${i < cat.value
                      ? cat.value === cat.max ? 'bg-emerald-500' : 'bg-yellow-400'
                      : 'bg-zinc-700'}`}
                  />
                ))}
              </div>
              <p className="text-[11px] text-zinc-500 leading-snug">{cat.desc}</p>
            </div>
          ))}
        </div>

        {/* P&L Payoff Chart */}
        <PayoffChart play={play} />

        {/* CTA */}
        <button
          onClick={() => { onClose(); onTrack(play); }}
          className={`w-full py-3 font-bold text-sm rounded-xl transition-colors text-black ${isHot ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-emerald-600 hover:bg-emerald-500'} ${isHot ? 'animate-pulse shadow-[0_0_16px_4px_rgba(16,185,129,0.5)]' : ''}`}
          style={isHot ? { boxShadow: '0 0 18px 5px rgba(16,185,129,0.45)' } : undefined}
        >
          {isHot ? '🔥 Track This Trade' : 'Track This Trade'}
        </button>
        </div>{/* end scrollable body */}
      </div>{/* end flex container */}
    </Modal>
  );
}

function RecommendModal({ position, onClose }: { position: Position; onClose: () => void }) {
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = `${getBase()}/api/recommend/${position.symbol}?short_strike=${position.short_strike}&long_strike=${position.long_strike}&entry_credit=${position.entry_credit}&pnl_pct=${position.pnl_pct ?? 0}`;
    fetch(url)
      .then(r => r.json())
      .then(setRec)
      .catch(() =>
        setRec({
          recommendation: 'hold',
          summary: 'Unable to fetch data',
          rsi: null,
          current_price: 0,
          buffer_pct: 0,
          reasons: ['Check your server connection'],
          exit_signals: 0,
        })
      )
      .finally(() => setLoading(false));
  }, [position]);

  const recStyle =
    rec?.recommendation === 'exit'
      ? 'text-red-400 border-red-500/30 bg-red-500/8'
      : rec?.recommendation === 'caution'
      ? 'text-yellow-400 border-yellow-500/30 bg-yellow-500/8'
      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/8';

  const pnl = position.pnl_pct ?? 0;

  return (
    <Modal onClose={onClose}>
      <div className="p-6">
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-bold text-white">Exit Recommendation</h3>
          <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        <div className="bg-zinc-900 rounded-xl p-3 mb-4 flex justify-between items-center">
          <div>
            <p className="font-bold text-white">{position.symbol}</p>
            <p className="text-xs text-zinc-400">${position.short_strike}/{position.long_strike} Put Spread</p>
          </div>
          <p className={`text-xl font-bold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%
          </p>
        </div>

        {loading ? (
          <div className="flex flex-col items-center py-10 gap-3">
            <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
            <p className="text-sm text-zinc-500">Fetching RSI & price data...</p>
          </div>
        ) : rec ? (
          <>
            <div className={`border rounded-2xl p-4 mb-4 ${recStyle}`}>
              <p className="text-lg font-bold">{rec.summary}</p>
              {rec.rsi != null && (
                <p className="text-sm opacity-80 mt-1">RSI-14: {rec.rsi}</p>
              )}
            </div>

            <div className="space-y-2 mb-4">
              {rec.reasons.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                  <span className="text-zinc-600 mt-0.5 shrink-0">•</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>

            {rec.current_price > 0 && (
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
                  <p className="text-[10px] text-zinc-500 uppercase">Stock Price</p>
                  <p className="text-sm font-semibold text-white">${rec.current_price.toFixed(2)}</p>
                </div>
                <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
                  <p className="text-[10px] text-zinc-500 uppercase">Buffer Left</p>
                  <p className={`text-sm font-semibold ${rec.buffer_pct < 3 ? 'text-red-400' : 'text-white'}`}>
                    {rec.buffer_pct.toFixed(1)}%
                  </p>
                </div>
                <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
                  <p className="text-[10px] text-zinc-500 uppercase">Signals</p>
                  <p className={`text-sm font-semibold ${rec.exit_signals >= 3 ? 'text-red-400' : rec.exit_signals >= 2 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                    {rec.exit_signals}/3
                  </p>
                </div>
              </div>
            )}
          </>
        ) : null}

        <button
          onClick={onClose}
          className="w-full mt-5 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold rounded-xl transition-colors"
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

// ─── Close Modal ──────────────────────────────────────────────────────────────

function CloseModal({
  position,
  onConfirm,
  onClose,
}: {
  position: Position;
  onConfirm: (exitCredit: number, reason: string) => void;
  onClose: () => void;
}) {
  const [exitCredit, setExitCredit] = useState(
    position.current_mid != null ? position.current_mid.toString() : ''
  );
  const [reason, setReason] = useState('manual');
  const reasons = ['manual', 'TP', 'SL', 'expired', 'rolled', 'other'];

  const pnlNum =
    exitCredit && position.entry_credit > 0
      ? ((position.entry_credit - parseFloat(exitCredit)) / position.entry_credit) * 100
      : null;
  const isWin = pnlNum != null && pnlNum >= 0;

  return (
    <Modal onClose={onClose}>
      <div className="p-6">
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-bold text-white">Close Position</h3>
          <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        <div className="bg-zinc-900 rounded-xl p-3 mb-4">
          <p className="font-bold text-white">{position.symbol}</p>
          <p className="text-sm text-zinc-400">
            ${position.short_strike}/{position.long_strike} · Entry credit: ${position.entry_credit.toFixed(2)}
          </p>
        </div>

        <p className="text-sm text-zinc-400 mb-2">Exit Credit (cost to close spread)</p>
        <input
          type="number"
          step="0.01"
          min="0"
          value={exitCredit}
          onChange={e => setExitCredit(e.target.value)}
          placeholder="e.g. 0.15"
          className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-3 text-white text-base placeholder:text-zinc-600 mb-4 focus:outline-none focus:border-emerald-500"
        />

        {pnlNum != null && (
          <div
            className={`text-center py-3 rounded-2xl mb-4 border ${
              isWin ? 'bg-emerald-500/8 border-emerald-500/25' : 'bg-red-500/8 border-red-500/25'
            }`}
          >
            <p className={`text-3xl font-bold ${isWin ? 'text-emerald-400' : 'text-red-400'}`}>
              {isWin ? '+' : ''}{pnlNum.toFixed(1)}%
            </p>
            <p className="text-xs text-zinc-500 mt-1">Final P&L</p>
          </div>
        )}

        <p className="text-sm text-zinc-400 mb-2">Reason</p>
        <div className="grid grid-cols-3 gap-2 mb-5">
          {reasons.map(r => (
            <button
              key={r}
              onClick={() => setReason(r)}
              className={`py-2 text-sm font-medium rounded-xl border transition-colors ${
                reason === r
                  ? 'bg-emerald-500 border-emerald-500 text-black'
                  : 'bg-zinc-900 border-zinc-700/60 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <button
          disabled={!exitCredit || isNaN(parseFloat(exitCredit))}
          onClick={() => onConfirm(parseFloat(exitCredit), reason)}
          className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 text-black font-bold rounded-xl transition-colors"
        >
          Confirm Close
        </button>
      </div>
    </Modal>
  );
}

// ─── Telegram Section ─────────────────────────────────────────────────────────

function TelegramSection({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);
  const command = `/start ${apiKey || 'frt_your_api_key'}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      <div className="flex items-center gap-3 bg-zinc-900 rounded-2xl p-4 mb-5">
        <span className="text-2xl">✈</span>
        <div>
          <p className="text-sm font-semibold text-white">Telegram Push Alerts</p>
          <p className="text-xs text-zinc-500">Elite — get notified instantly on your phone</p>
        </div>
      </div>

      <div className="space-y-4 mb-5">
        {/* Step 1 */}
        <div className="bg-zinc-900 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Step 1</p>
          <p className="text-sm text-zinc-200 mb-2">Tap to open the bot in Telegram:</p>
          <a
            href="https://t.me/FortressOptionsBot"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold text-sm rounded-xl py-3 px-4 transition-colors"
          >
            <span>✈</span>
            <span>Open @FortressOptionsBot</span>
          </a>
        </div>

        {/* Step 2 */}
        <div className="bg-zinc-900 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Step 2</p>
          <p className="text-sm text-zinc-200 mb-3">Copy your link command and send it to the bot:</p>
          <div className="bg-zinc-800 rounded-xl p-3 mb-3">
            <code className="text-emerald-400 text-xs break-all select-all">{command}</code>
          </div>
          <button
            onClick={handleCopy}
            className={`w-full flex items-center justify-center gap-2 font-semibold text-sm rounded-xl py-3 px-4 transition-colors ${
              copied
                ? 'bg-emerald-600 text-white'
                : 'bg-zinc-700 hover:bg-zinc-600 active:bg-zinc-800 text-white'
            }`}
          >
            {copied ? '✓ Copied!' : '⎘ Copy Command'}
          </button>
        </div>

        {/* Step 3 */}
        <div className="bg-zinc-900 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Step 3</p>
          <p className="text-sm text-zinc-200">The bot confirms — you're connected. That's it!</p>
        </div>
      </div>

      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-xs text-emerald-400 text-center">
        You'll receive instant alerts when any position hits +20% profit or −10% loss
      </div>
    </>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────

// ─── How to Use Modal ─────────────────────────────────────────────────────────

function HowToUseModal({ onClose }: { onClose: () => void }) {
  const sections = [
    {
      icon: '🏰',
      title: 'What is Fortress Options?',
      body: 'Fortress Options is an AI-powered scanner that finds high-probability bull put spread opportunities on top stocks. The bot scans the market every 30 minutes during trading hours and alerts you to the best setups.',
    },
    {
      icon: '📊',
      title: 'What is a Bull Put Spread?',
      body: 'A bull put spread is a credit options strategy. You sell a put at a higher strike (collecting premium) and buy a put at a lower strike (protection). You profit if the stock stays above your short strike at expiration. Maximum profit = the credit collected. Maximum loss = spread width minus credit.',
    },
    {
      icon: '🃏',
      title: 'Reading a Play Card',
      items: [
        { label: 'Score', desc: 'Fortress AI rates each play 0–10. 8+ is a hot setup (glowing card). 6–7 is solid. Under 5 is weak.' },
        { label: 'Sell (Short Strike)', desc: 'The put you sell to collect credit. Stock must stay above this price at expiration.' },
        { label: 'Buy (Long Strike)', desc: 'The put you buy as protection. Caps your maximum loss.' },
        { label: 'Credit', desc: 'The premium you receive per share when you open the trade. This is your max profit.' },
        { label: 'Buffer %', desc: 'How far the stock can fall before your short strike is breached. Higher is safer.' },
        { label: 'Return %', desc: 'Credit divided by spread width. Your return on capital if the trade expires worthless.' },
        { label: 'Max Risk', desc: 'Worst-case loss per contract = (spread width − credit) × 100.' },
      ],
    },
    {
      icon: '🔥',
      title: 'The Score System (0–10)',
      items: [
        { label: '💰 Premium (0–3)', desc: 'Higher credit relative to spread width = higher score.' },
        { label: '🛡️ Buffer (0–2)', desc: 'More distance between current price and short strike = safer.' },
        { label: '🌊 Liquidity (0–2)', desc: 'High volume and open interest = tighter bid/ask and easier fills.' },
        { label: '📅 DTE (0–2)', desc: '9–12 days to expiry is the sweet spot for theta decay.' },
        { label: '📊 IV (0–1)', desc: 'Elevated implied volatility means richer premium to sell.' },
      ],
    },
    {
      icon: '🏦',
      title: 'How to Place the Trade',
      items: [
        { label: 'Step 1', desc: 'Open your brokerage app (Robinhood, Tastytrade, TD Ameritrade, etc.).' },
        { label: 'Step 2', desc: 'Search for the stock symbol (e.g., SPY).' },
        { label: 'Step 3', desc: 'Navigate to Options → Put → select the expiration date shown.' },
        { label: 'Step 4', desc: 'Sell the short strike put and buy the long strike put as a spread.' },
        { label: 'Step 5', desc: 'Enter a limit order at or near the credit shown. Use 1+ contracts.' },
        { label: 'Step 6', desc: 'Tap "Track Trade" in Fortress to monitor your position.' },
      ],
    },
    {
      icon: '📈',
      title: 'Managing Positions',
      body: 'After entering a trade, add it to the Tracker. Fortress monitors it live — when your profit hits 50% of max (i.e., you\'ve captured half the credit), consider closing early to lock in gains. If the stock drops near your short strike, the AI will recommend "Caution" or "Exit". Tap "AI Advice" on any position for a real-time recommendation.',
    },
    {
      icon: '🔔',
      title: 'Alerts & Notifications',
      body: 'Fortress sends push notifications for: new high-score plays found, profit targets reached (50% profit), loss warnings (position in danger), and the daily 8:30 AM market open briefing. Make sure notifications are enabled in your Android settings.',
    },
    {
      icon: '⚡',
      title: 'Tips for Best Results',
      items: [
        { label: 'Score 8+', desc: 'Only trade plays with score 8 or higher for the best risk-adjusted setups.' },
        { label: 'Buffer 5%+', desc: 'A buffer of 5% or more gives the stock room to move without threatening your position.' },
        { label: 'Close at 50%', desc: 'Take profit when you\'ve made 50% of the max credit. Don\'t get greedy.' },
        { label: 'Risk 1–2%', desc: 'Never risk more than 1–2% of your account on a single spread.' },
        { label: 'Earnings', desc: 'Earnings plays are higher risk/reward. Look for the orange "Earnings" badge.' },
      ],
    },
  ];

  return (
    <Modal onClose={onClose}>
      <div className="max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-[#1C1C1E] border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-xl">📖</span>
            <h3 className="text-lg font-bold text-white">How to Use Fortress</h3>
          </div>
          <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {sections.map((sec, i) => (
            <div key={i} className="bg-zinc-900/70 border border-zinc-800/60 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">{sec.icon}</span>
                <h4 className="text-sm font-bold text-white">{sec.title}</h4>
              </div>
              {'body' in sec && sec.body && (
                <p className="text-[13px] text-zinc-400 leading-relaxed">{sec.body}</p>
              )}
              {'items' in sec && sec.items && (
                <div className="space-y-2">
                  {sec.items.map((item, j) => (
                    <div key={j} className="flex gap-2">
                      <span className="text-[12px] font-bold text-emerald-400 shrink-0 min-w-[80px]">{item.label}</span>
                      <span className="text-[12px] text-zinc-400 leading-snug">{item.desc}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-2xl p-4 text-center">
            <p className="text-sm font-bold text-emerald-400 mb-1">🏰 You're all set!</p>
            <p className="text-[12px] text-zinc-400">Fortress does the scanning. You make the calls. Trade smart.</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { dark, toggle: toggleTheme } = useTheme();
  const [apiKey, setApiKey] = useState(localStorage.getItem('fortress_api_key') || '');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState('');
  const [section, setSection] = useState<'connection' | 'security' | 'telegram' | 'watchlist'>('connection');
  const [tier, setTier] = useState<string | null>(null);
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(localStorage.getItem('fortress_use_biometric') === 'true');
  const [lockTimeout, setLockTimeout] = useState<string>(localStorage.getItem('fortress_lock_timeout') || '5');
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [wlInput, setWlInput] = useState('');
  const [wlLoading, setWlLoading] = useState(false);
  const [profitTarget, setProfitTarget] = useState<number>(
    Number(localStorage.getItem('fortress_profit_target') || '50')
  );
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/verify').then(d => setTier(d.tier)).catch(() => {});
    if (window.Capacitor?.isPluginAvailable?.('BiometricAuthNative')) {
      import('@aparajita/capacitor-biometric-auth').then(({ BiometricAuth }) => {
        BiometricAuth.checkBiometry().then((r) => setBiometricAvail(r.isAvailable)).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  const loadWatchlist = () => {
    apiFetch('/api/watchlist').then(d => setWatchlist(d.symbols || [])).catch(() => {});
  };

  useEffect(() => {
    if (section === 'watchlist') loadWatchlist();
  }, [section]);

  const [wlError, setWlError] = useState('');

  const addSymbol = async () => {
    const sym = wlInput.trim().toUpperCase();
    if (!sym) return;
    setWlLoading(true);
    setWlError('');
    try {
      const res = await apiFetch('/api/watchlist/add', { method: 'POST', body: JSON.stringify({ symbol: sym }) });
      setWlInput('');
      setWatchlist(res.symbols || []);
    } catch (e: any) {
      setWlError(e?.message || 'Failed to add symbol');
    }
    setWlLoading(false);
  };

  const removeSymbol = async (sym: string) => {
    try {
      const res = await apiFetch(`/api/watchlist/${sym}`, { method: 'DELETE' });
      setWatchlist(res.symbols || []);
    } catch {}
  };

  const saveConnection = () => {
    localStorage.removeItem('fortress_server'); // clear any old local IP
    localStorage.setItem('fortress_api_key', apiKey);
    onClose();
    window.location.reload();
  };

  const openBillingPortal = async () => {
    setPortalLoading(true);
    try {
      const data = await apiFetch('/api/billing-portal', { method: 'POST' });
      if (data.url) {
        window.open(data.url, '_blank');
      }
    } catch {
      alert('Could not open billing portal. Please email support@fortress-options.com.');
    } finally {
      setPortalLoading(false);
    }
  };

  const savePin = () => {
    setPinError('');
    setPinSuccess('');
    const saved = localStorage.getItem('fortress_pin') || '1234';
    if (currentPin !== saved) { setPinError('Current PIN is incorrect'); return; }
    if (!/^\d{4}$/.test(newPin)) { setPinError('New PIN must be exactly 4 digits'); return; }
    if (newPin !== confirmPin) { setPinError('PINs do not match'); return; }
    localStorage.setItem('fortress_pin', newPin);
    setPinSuccess('PIN updated successfully');
    setCurrentPin(''); setNewPin(''); setConfirmPin('');
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-bold text-white">Settings</h3>
          <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Tabs — row 1 */}
        <div className="flex bg-zinc-900 rounded-xl p-1 mb-1">
          {(['connection', 'security'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
                section === s ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s === 'connection' ? 'Connection' : 'Security'}
            </button>
          ))}
        </div>
        {/* Tabs — row 2 */}
        <div className="flex bg-zinc-900 rounded-xl p-1 mb-5">
          {(['telegram', 'watchlist'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
                section === s ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s === 'telegram' ? '✈ Telegram' : '📋 Watchlist'}
            </button>
          ))}
        </div>

        {section === 'connection' && (
          <>
            <p className="text-sm text-zinc-400 mb-2 flex items-center gap-2">
              <KeyRound className="w-4 h-4" /> API Key
            </p>
            <input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="frt_xxxxxxxxxxxxxxxxxxxx"
              className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 mb-1 focus:outline-none focus:border-emerald-500 font-mono"
            />
            <p className="text-xs text-zinc-600 mb-5">
              Subscribe at <span className="text-emerald-500">fortress-options.com</span> to get your key.
            </p>

            <button
              onClick={saveConnection}
              className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-xl transition-colors"
            >
              Save & Reconnect
            </button>

            {tier && (
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-white capitalize">{tier} Plan</p>
                    <p className="text-xs text-zinc-500">Manage billing, cancel, or update payment</p>
                  </div>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 capitalize">{tier}</span>
                </div>
                <button
                  onClick={openBillingPortal}
                  disabled={portalLoading}
                  className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors border border-zinc-700"
                >
                  {portalLoading ? 'Opening…' : 'Manage Subscription →'}
                </button>
              </div>
            )}
          </>
        )}

        {section === 'security' && (
          <>
            {/* Dark / Light mode toggle */}
            <button
              onClick={toggleTheme}
              className="w-full flex items-center justify-between bg-zinc-900 rounded-2xl p-4 mb-4 border border-zinc-800"
            >
              <div className="flex items-center gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {dark
                    ? <><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>
                    : <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  }
                </svg>
                <div className="text-left">
                  <p className="text-sm font-semibold text-white">{dark ? 'Dark Mode' : 'Light Mode'}</p>
                  <p className="text-xs text-zinc-500">Tap to switch to {dark ? 'light' : 'dark'} mode</p>
                </div>
              </div>
              <div className={`w-11 h-6 rounded-full transition-colors relative ${!dark ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${!dark ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </button>

            {biometricAvail && (
              <button
                onClick={() => {
                  const next = !biometricEnabled;
                  setBiometricEnabled(next);
                  if (next) {
                    localStorage.setItem('fortress_use_biometric', 'true');
                  } else {
                    localStorage.removeItem('fortress_use_biometric');
                  }
                }}
                className="w-full flex items-center justify-between bg-zinc-900 rounded-2xl p-4 mb-4 border border-zinc-800"
              >
                <div className="flex items-center gap-3">
                  <Fingerprint className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div className="text-left">
                    <p className="text-sm font-semibold text-white">Biometric Unlock</p>
                    <p className="text-xs text-zinc-500">Use fingerprint or face ID to unlock</p>
                  </div>
                </div>
                <div className={`w-11 h-6 rounded-full transition-colors relative ${biometricEnabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${biometricEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
              </button>
            )}

            {/* Auto-lock timeout */}
            <div className="bg-zinc-900 rounded-2xl p-4 mb-5 border border-zinc-800">
              <div className="flex items-center gap-3 mb-3">
                <Lock className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-white">Auto-Lock</p>
                  <p className="text-xs text-zinc-500">Lock app after period of inactivity</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: '1 min',  value: '1' },
                  { label: '5 min',  value: '5' },
                  { label: '15 min', value: '15' },
                  { label: '30 min', value: '30' },
                  { label: '1 hour', value: '60' },
                  { label: 'Never',  value: '0' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setLockTimeout(opt.value);
                      localStorage.setItem('fortress_lock_timeout', opt.value);
                    }}
                    className={`py-2 rounded-xl text-sm font-medium transition-colors ${
                      lockTimeout === opt.value
                        ? 'bg-emerald-500 text-black'
                        : 'bg-zinc-800 text-zinc-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-sm text-zinc-400 mb-2">Current PIN</p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={currentPin}
              onChange={e => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="••••"
              className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 mb-3 focus:outline-none focus:border-emerald-500 tracking-widest text-center text-lg"
            />

            <p className="text-sm text-zinc-400 mb-2">New PIN (4 digits)</p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={newPin}
              onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="••••"
              className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 mb-3 focus:outline-none focus:border-emerald-500 tracking-widest text-center text-lg"
            />

            <p className="text-sm text-zinc-400 mb-2">Confirm New PIN</p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={confirmPin}
              onChange={e => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="••••"
              className="w-full bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 mb-4 focus:outline-none focus:border-emerald-500 tracking-widest text-center text-lg"
            />

            {pinError && <p className="text-red-400 text-sm mb-3 text-center">{pinError}</p>}
            {pinSuccess && <p className="text-emerald-400 text-sm mb-3 text-center">{pinSuccess}</p>}

            <button
              onClick={savePin}
              disabled={!currentPin || !newPin || !confirmPin}
              className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 text-black font-bold rounded-xl transition-colors"
            >
              Update PIN
            </button>

            {/* Alert Threshold */}
            <div className="mt-6 bg-zinc-900 rounded-2xl p-4 border border-zinc-800">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-white">Profit Target</p>
                  <p className="text-xs text-zinc-500">Alert me when position reaches this % profit</p>
                </div>
                <span className="text-lg font-bold text-emerald-400">{profitTarget}%</span>
              </div>
              <input
                type="range"
                min={20} max={90} step={5}
                value={profitTarget}
                onChange={e => {
                  const v = Number(e.target.value);
                  setProfitTarget(v);
                  localStorage.setItem('fortress_profit_target', String(v));
                }}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
                <span>20%</span><span>50% (standard)</span><span>90%</span>
              </div>
            </div>
          </>
        )}

        {section === 'telegram' && (
          <TelegramSection apiKey={apiKey} />
        )}

        {section === 'watchlist' && (
          <>
            <p className="text-xs text-zinc-500 mb-3">Add any ticker you want to track personally. Plays for these symbols will appear in your feed even if they're outside your tier's default list.</p>

            {/* Add symbol */}
            <div className="flex gap-2 mb-1">
              <input
                value={wlInput}
                onChange={e => { setWlInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, '')); setWlError(''); }}
                onKeyDown={e => e.key === 'Enter' && addSymbol()}
                placeholder="e.g. AAPL"
                maxLength={6}
                className="flex-1 bg-zinc-900 border border-zinc-700/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500 font-mono uppercase"
              />
              <button
                onClick={addSymbol}
                disabled={wlLoading || !wlInput.trim()}
                className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black font-bold rounded-xl text-sm transition-colors"
              >
                {wlLoading ? '…' : 'Add'}
              </button>
            </div>
            {wlError && <p className="text-xs text-red-400 mb-2">{wlError}</p>}

            {/* Symbol chips */}
            <div className="mt-3">
              {watchlist.length === 0 ? (
                <p className="text-center text-zinc-600 text-sm py-6">No symbols yet — add some above</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {watchlist.map(sym => (
                    <div key={sym} className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700/60 rounded-full px-3 py-1.5">
                      <span className="text-sm font-mono font-semibold text-white">{sym}</span>
                      <button
                        onClick={() => removeSymbol(sym)}
                        className="text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Version footer */}
        <p className="text-center text-xs text-zinc-600 mt-6">Fortress Options v{CURRENT_VERSION}{tier ? ` · ${tier.charAt(0).toUpperCase() + tier.slice(1)}` : ''}</p>
      </div>
    </Modal>
  );
}

// ─── Lock Screen ─────────────────────────────────────────────────────────────

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const isFirstSetup = !localStorage.getItem('fortress_pin');
  const biometricPreferred = localStorage.getItem('fortress_use_biometric') === 'true';
  const [mode, setMode] = useState<'setup' | 'setup-confirm' | 'biometric' | 'pin'>(
    isFirstSetup ? 'setup' : biometricPreferred ? 'biometric' : 'pin'
  );
  const [setupPin, setSetupPin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [biometryAvailable, setBiometryAvailable] = useState(false);

  // Auto-trigger biometric on load when it's the preferred method
  useEffect(() => {
    if (mode !== 'biometric') return;
    if (window.Capacitor?.isPluginAvailable?.('BiometricAuthNative')) {
      setBiometryAvailable(true);
      triggerBiometric();
    } else {
      // Not on device — fall back to PIN
      setMode('pin');
    }
  }, [mode]);

  const triggerBiometric = async () => {
    try {
      const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
      await BiometricAuth.authenticate({
        reason: 'Unlock Fortress Options',
        cancelTitle: 'Use PIN',
        fallbackTitle: 'Use PIN',
      });
      onUnlock();
    } catch {
      // User cancelled or failed — stay on biometric screen, allow retry or PIN
    }
  };

  const handleDigit = (d: string) => {
    if (mode === 'setup') {
      const next = setupPin + d;
      setSetupPin(next);
      setError('');
      if (next.length === 4) {
        setTimeout(() => { setMode('setup-confirm'); setPin(''); setError(''); }, 150);
      }
    } else if (mode === 'setup-confirm') {
      const next = pin + d;
      setPin(next);
      setError('');
      if (next.length === 4) {
        if (next === setupPin) {
          localStorage.setItem('fortress_pin', next);
          onUnlock();
        } else {
          setError('PINs do not match — try again');
          setSetupPin('');
          setPin('');
          setTimeout(() => setMode('setup'), 800);
        }
      }
    } else {
      const savedPin = localStorage.getItem('fortress_pin') || '';
      const next = pin + d;
      setPin(next);
      setError('');
      if (next.length === 4) {
        if (next === savedPin || savedPin === 'biometric') {
          onUnlock();
        } else {
          setError('Incorrect PIN');
          setPin('');
        }
      }
    }
  };

  const handleBackspace = () => {
    if (mode === 'setup') setSetupPin(p => p.slice(0, -1));
    else setPin(p => p.slice(0, -1));
  };

  // Keyboard support — lets desktop users type digits instead of clicking the numpad
  const handleDigitRef = useRef(handleDigit);
  const handleBackspaceRef = useRef(handleBackspace);
  handleDigitRef.current = handleDigit;
  handleBackspaceRef.current = handleBackspace;
  useEffect(() => {
    if (mode === 'biometric') return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) handleDigitRef.current(e.key);
      else if (e.key === 'Backspace') handleBackspaceRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  const currentLen = mode === 'setup' ? setupPin.length : pin.length;
  const digits = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  // ── Biometric unlock screen ──────────────────────────────────────────────
  if (mode === 'biometric') {
    return (
      <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col items-center justify-center gap-8">
        <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-[0_0_32px_rgba(16,185,129,0.4)]">
          <Shield className="w-9 h-9 text-black" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Fortress Options</h1>
          <p className="text-sm text-zinc-500 mt-1">Touch the sensor to unlock</p>
        </div>

        {/* Big fingerprint tap target */}
        <button
          onClick={triggerBiometric}
          className="w-32 h-32 rounded-full bg-zinc-900 border-2 border-emerald-500/40 flex items-center justify-center active:scale-95 transition-transform shadow-[0_0_40px_rgba(16,185,129,0.15)]"
        >
          <Fingerprint className="w-16 h-16 text-emerald-400" />
        </button>

        <p className="text-emerald-400 text-sm font-medium">Tap to use fingerprint</p>

        <button
          onClick={() => { setMode('pin'); setPin(''); setError(''); }}
          className="text-zinc-500 text-sm mt-2"
        >
          Use PIN instead
        </button>
      </div>
    );
  }

  // ── PIN / setup screens ──────────────────────────────────────────────────
  const title = mode === 'setup'
    ? 'Create Your PIN'
    : mode === 'setup-confirm'
    ? 'Confirm Your PIN'
    : 'Fortress Options';

  const subtitle = mode === 'setup'
    ? 'Choose a 4-digit PIN to secure your app'
    : mode === 'setup-confirm'
    ? 'Enter your PIN again to confirm'
    : 'Enter PIN to continue';

  return (
    <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col items-center justify-center gap-8">
      <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-[0_0_32px_rgba(16,185,129,0.4)]">
        <Shield className="w-9 h-9 text-black" />
      </div>
      <div>
        <h1 className="text-2xl font-bold text-white text-center">{title}</h1>
        <p className="text-sm text-zinc-500 text-center mt-1">{subtitle}</p>
      </div>

      {/* PIN dots */}
      <div className="flex gap-4">
        {[0,1,2,3].map(i => (
          <div key={i} className={`w-4 h-4 rounded-full border-2 transition-all ${
            i < currentLen ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'
          }`} />
        ))}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-3 w-64">
        {digits.map((d, i) => (
          d === '' ? (
            biometryAvailable && mode === 'pin' ? (
              <button
                key={i}
                onClick={triggerBiometric}
                className="h-16 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 rounded-2xl flex items-center justify-center transition-colors border border-zinc-800"
              >
                <Fingerprint className="w-7 h-7 text-emerald-400" />
              </button>
            ) : <div key={i} />
          ) :
          <button
            key={i}
            onClick={() => d === '⌫' ? handleBackspace() : handleDigit(d)}
            className="h-16 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 rounded-2xl text-white text-xl font-semibold transition-colors border border-zinc-800"
          >
            {d}
          </button>
        ))}
      </div>

      {biometricPreferred && mode === 'pin' && (
        <button onClick={() => setMode('biometric')} className="text-zinc-500 text-sm">
          ← Back to fingerprint
        </button>
      )}
    </div>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlowLoad(true), 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3">
      {/* Skeleton cards */}
      {[0,1,2].map(i => (
        <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 animate-pulse">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-zinc-800" />
              <div>
                <div className="w-14 h-4 bg-zinc-800 rounded mb-1.5" />
                <div className="w-20 h-3 bg-zinc-800 rounded" />
              </div>
            </div>
            <div className="w-12 h-6 bg-zinc-800 rounded-full" />
          </div>
          <div className="flex gap-2 mt-3">
            <div className="flex-1 h-8 bg-zinc-800 rounded-xl" />
            <div className="flex-1 h-8 bg-zinc-800 rounded-xl" />
            <div className="flex-1 h-8 bg-zinc-800 rounded-xl" />
          </div>
        </div>
      ))}
      {slowLoad && (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
          <p className="text-zinc-500 text-xs">Server is waking up — this takes ~30 sec on first load</p>
          <p className="text-zinc-600 text-xs">Subsequent loads will be instant</p>
        </div>
      )}
    </div>
  );
}

// ─── Screens ─────────────────────────────────────────────────────────────────

function PlaysScreen({
  plays, loading, scanning, marketOpen, onTrack, onViewReasoning, onRefresh,
}: {
  plays: Play[];
  loading: boolean;
  scanning: boolean;
  marketOpen: boolean;
  onTrack: (p: Play) => void;
  onViewReasoning: (p: Play) => void;
  onRefresh: () => void;
}) {
  // Most recent scan time = latest found_at across all plays
  const lastScan = plays.length
    ? plays.reduce((best, p) => {
        if (!p.found_at) return best;
        return !best || p.found_at > best ? p.found_at : best;
      }, '' as string)
    : '';
  const lastScanLabel = lastScan ? `Last scan ${formatFoundAt(lastScan)}` : null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 sticky top-0 bg-[#0A0A0B]/90 backdrop-blur-sm z-10 border-b border-zinc-800/50">
        <div>
          <h2 className="text-sm font-bold text-white">Ranked Plays</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-xs text-zinc-500">{plays.length} found · newest first</p>
            {lastScanLabel && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                <Clock className="w-2.5 h-2.5" />
                {lastScanLabel}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={!marketOpen || scanning}
          title={!marketOpen ? 'Market closed — scanner pauses until 9:30 AM ET' : undefined}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm transition-colors ${
            !marketOpen || scanning
              ? 'bg-zinc-800/50 text-zinc-600 cursor-not-allowed'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scanning || loading ? 'animate-spin text-emerald-400' : ''}`} />
          {scanning ? 'Scanning…' : !marketOpen ? 'Closed' : 'Scan'}
        </button>
      </div>

      {loading && plays.length === 0 ? (
        <LoadingSkeleton />
      ) : plays.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-zinc-600 gap-3 px-6 text-center">
          {isMarketJustOpened() ? (
            <>
              <div className="relative">
                <Target className="w-14 h-14 opacity-20" />
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 animate-ping" />
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500" />
              </div>
              <p className="font-semibold text-zinc-400">Scanning for plays…</p>
              <p className="text-sm text-zinc-500 max-w-xs leading-relaxed">
                Market just opened at 9:30 AM ET. The scanner is running — plays appear once
                liquidity settles (usually within 5–10 minutes).
              </p>
            </>
          ) : isMarketOpen() ? (
            <>
              <Target className="w-14 h-14 opacity-20" />
              <p className="font-medium text-zinc-500">No plays found</p>
              <p className="text-sm text-zinc-600">Tap Scan to check the market</p>
            </>
          ) : (
            <>
              <Target className="w-14 h-14 opacity-20" />
              <p className="font-medium text-zinc-500">Market is closed</p>
              <p className="text-sm text-zinc-600">Scanner runs Mon–Fri 9:30 AM – 4:00 PM ET</p>
            </>
          )}
        </div>
      ) : (
        <div className="px-4 py-4 space-y-4">
          {plays.map(p => (
            <PlayCard key={p.id} play={p} onTrack={onTrack} onViewReasoning={onViewReasoning} />
          ))}
        </div>
      )}
    </div>
  );
}

function PositionsScreen({
  positions, loading, onRefresh, onRecommend, onClose,
}: {
  positions: Position[];
  loading: boolean;
  onRefresh: () => void;
  onRecommend: (p: Position) => void;
  onClose: (p: Position) => void;
}) {
  const avgPnl = positions.length
    ? positions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / positions.length
    : 0;
  const profitable = positions.filter(p => (p.pnl_pct ?? 0) > 0).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-3 sticky top-0 bg-[#0A0A0B]/90 backdrop-blur-sm z-10 border-b border-zinc-800/50">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-sm font-bold text-white">Open Positions</h2>
            <p className="text-xs text-zinc-500">{positions.length} tracked</p>
          </div>
          <button
            onClick={onRefresh}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
          >
            <RefreshCw className={`w-4 h-4 text-zinc-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {positions.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Open</p>
              <p className="font-bold text-white">{positions.length}</p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Avg P&L</p>
              <p className={`font-bold ${avgPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {avgPnl >= 0 ? '+' : ''}{avgPnl.toFixed(1)}%
              </p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Winning</p>
              <p className="font-bold text-white">{profitable}/{positions.length}</p>
            </div>
          </div>
        )}
      </div>

      {loading && positions.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
        </div>
      ) : positions.length === 0 ? (
        <div className="flex flex-col items-center py-20 gap-3 text-zinc-600">
          <BarChart2 className="w-14 h-14 opacity-20" />
          <p className="font-medium text-zinc-500">No open positions</p>
          <p className="text-sm">Track a play from the Plays tab</p>
        </div>
      ) : (
        <div className="px-4 py-4 space-y-4">
          {positions.map(p => (
            <PositionCard key={p.id} pos={p} onRecommend={onRecommend} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}

function exportHistoryCSV(history: Position[]) {
  const headers = ['Symbol','Type','Short Strike','Long Strike','Expiration','Entry Credit','Exit Credit','Contracts','P&L %','Status','Exit Reason','Closed At'];
  const rows = history.map(p => [
    p.symbol,
    p.play_type || 'bull_put',
    p.short_strike,
    p.long_strike,
    p.expiration,
    p.entry_credit?.toFixed(2) ?? '',
    p.exit_credit?.toFixed(2) ?? '',
    p.contracts ?? 1,
    p.pnl_pct?.toFixed(1) ?? '',
    p.status,
    p.exit_reason ?? '',
    p.closed_at?.slice(0, 10) ?? '',
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fortress-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function HistoryScreen({ history, loading }: { history: Position[]; loading: boolean }) {
  // Win = closed with >= 30% of max profit captured (matches server definition)
  const wins = history.filter(p => (p.pnl_pct ?? 0) >= 30).length;
  const totalPnl = history.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);
  const avgPnl = history.length ? totalPnl / history.length : 0;
  const bestTrade = history.length ? Math.max(...history.map(p => p.pnl_pct ?? 0)) : 0;

  const [serverStats, setServerStats] = useState<{ total_trades: number; win_rate: number; avg_pnl: number; best_trade: number } | null>(null);

  useEffect(() => {
    apiFetch('/api/stats').then(d => setServerStats(d)).catch(() => {});
  }, []);

  const displayWinRate = serverStats ? serverStats.win_rate.toFixed(0) : (history.length ? ((wins / history.length) * 100).toFixed(0) : '0');
  const displayAvgPnl = serverStats ? serverStats.avg_pnl : avgPnl;
  const displayBest = serverStats ? serverStats.best_trade : bestTrade;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-3 sticky top-0 bg-[#0A0A0B]/90 backdrop-blur-sm z-10 border-b border-zinc-800/50">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-sm font-bold text-white">Trade History</h2>
            <p className="text-xs text-zinc-500">{serverStats ? serverStats.total_trades : history.length} closed trades</p>
          </div>
          {history.length > 0 && (
            <button
              onClick={() => exportHistoryCSV(history)}
              className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-3 py-1.5 rounded-full active:opacity-70 transition-opacity"
            >
              ⬇ Export CSV
            </button>
          )}
        </div>
        {(history.length > 0 || serverStats) && (
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Win Rate</p>
              <p className="font-bold text-emerald-400">{displayWinRate}%</p>
              <p className="text-[9px] text-zinc-600 mt-0.5">≥30% profit = win</p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Avg P&L</p>
              <p className={`font-bold ${displayAvgPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {displayAvgPnl >= 0 ? '+' : ''}{displayAvgPnl.toFixed(0)}%
              </p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">W / L</p>
              <p className="font-bold text-white">{wins} / {history.length - wins}</p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Best Trade</p>
              <p className="font-bold text-emerald-400">+{displayBest.toFixed(0)}%</p>
            </div>
          </div>
        )}
      </div>

      {loading && history.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
        </div>
      ) : history.length === 0 ? (
        <div className="flex flex-col items-center py-20 gap-3 text-zinc-600">
          <BookOpen className="w-14 h-14 opacity-20" />
          <p className="font-medium text-zinc-500">No closed trades yet</p>
        </div>
      ) : (
        <div className="px-4 py-4 space-y-2">
          {history.map(p => <HistoryRow key={p.id} pos={p} />)}
        </div>
      )}
    </div>
  );
}

function AlertsScreen({
  alerts, loading, onAck, onDelete, onClearAll,
}: {
  alerts: Alert[];
  loading: boolean;
  onAck: (id: number) => void;
  onDelete: (id: number) => void;
  onClearAll: () => void;
}) {
  const unread = alerts.filter(a => !a.acknowledged).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-3 sticky top-0 bg-[#0A0A0B]/90 backdrop-blur-sm z-10 border-b border-zinc-800/50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Alerts</h2>
            <p className="text-xs text-zinc-500">{unread} unread</p>
          </div>
          {alerts.length > 0 && (
            <button
              onClick={onClearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-red-400 text-xs font-medium transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Clear All
            </button>
          )}
        </div>
      </div>

      {loading && alerts.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex flex-col items-center py-20 gap-3 text-zinc-600">
          <Bell className="w-14 h-14 opacity-20" />
          <p className="font-medium text-zinc-500">No alerts yet</p>
          <p className="text-sm">20%+ profit and 10%+ loss alerts appear here</p>
        </div>
      ) : (
        <div className="px-4 py-4 space-y-3">
          {alerts.map(a => <AlertRow key={a.id} alert={a} onAck={onAck} onDelete={onDelete} />)}
        </div>
      )}
    </div>
  );
}

// ─── Earnings Screen ─────────────────────────────────────────────────────────

interface EarningsEvent {
  ticker: string;
  company: string;
  date: string;
  time: 'Before Open' | 'After Close';
  tier: 'pro' | 'all';
}

const EARNINGS_FALLBACK: EarningsEvent[] = [
  { ticker: 'GOOGL', company: 'Alphabet Inc.',      date: 'Apr 29, 2025', time: 'After Close', tier: 'pro' },
  { ticker: 'META',  company: 'Meta Platforms',     date: 'Apr 30, 2025', time: 'After Close', tier: 'pro' },
  { ticker: 'MSFT',  company: 'Microsoft Corp.',    date: 'Apr 30, 2025', time: 'After Close', tier: 'pro' },
  { ticker: 'AAPL',  company: 'Apple Inc.',         date: 'May 1, 2025',  time: 'After Close', tier: 'pro' },
  { ticker: 'AMZN',  company: 'Amazon.com Inc.',    date: 'May 1, 2025',  time: 'After Close', tier: 'pro' },
  { ticker: 'NVDA',  company: 'NVIDIA Corp.',       date: 'May 28, 2025', time: 'After Close', tier: 'pro' },
];

function EarningsScreen() {
  const [events, setEvents] = useState<EarningsEvent[]>(EARNINGS_FALLBACK);
  const [loadingEarnings, setLoadingEarnings] = useState(true);

  useEffect(() => {
    // Use the dynamic backend endpoint instead of the static earnings.json on
    // Vercel — that file went a year stale because admin-panel writes never
    // got pushed to GitHub. /api/earnings is computed live from yfinance for
    // every symbol the scanner sees (global + per-user watchlists), with a
    // 30-min cache on the server side.
    apiFetch('/api/earnings')
      .then(data => {
        if (Array.isArray(data.events) && data.events.length > 0) {
          setEvents(data.events.map((e: any) => ({ ...e, tier: 'pro' as const })));
        }
      })
      .catch(err => console.warn('[Earnings] fetch failed:', err))
      .finally(() => setLoadingEarnings(false));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3">
      <div className="mb-4">
        <h2 className="text-white text-xl font-bold">Upcoming Earnings</h2>
        <p className="text-zinc-500 text-sm mt-1">AI-scored options plays delivered at market open.</p>
      </div>
      {loadingEarnings ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : events.map((e) => (
        <div key={e.ticker} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <span className="text-emerald-400 text-xs font-extrabold">{e.ticker}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm">{e.ticker}</p>
            <p className="text-zinc-500 text-xs truncate">{e.company}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-white text-xs font-medium">{e.date}</p>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full mt-1 inline-block ${
              e.time === 'Before Open'
                ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
            }`}>{e.time}</span>
          </div>
        </div>
      ))}
      <p className="text-center text-zinc-600 text-xs pt-2 pb-4">Pro &amp; Elite subscribers get plays automatically.</p>
    </div>
  );
}

// ─── Bottom Navigation ────────────────────────────────────────────────────────

function BottomNav({
  tab, setTab, alertCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  alertCount: number;
}) {
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'plays',     label: 'Plays',     icon: <Target className="w-5 h-5" /> },
    { id: 'positions', label: 'Positions', icon: <BarChart2 className="w-5 h-5" /> },
    { id: 'earnings',  label: 'Earnings',  icon: <CalendarDays className="w-5 h-5" /> },
    { id: 'history',   label: 'History',   icon: <BookOpen className="w-5 h-5" /> },
    { id: 'alerts',    label: 'Alerts',    icon: <Bell className="w-5 h-5" /> },
  ];

  return (
    <nav className="shrink-0 flex bg-[#0D0D0E] border-t border-zinc-800/80 safe-area-bottom">
      {items.map(item => (
        <button
          key={item.id}
          onClick={() => setTab(item.id)}
          className={`flex-1 flex flex-col items-center gap-1 py-3 relative transition-colors ${
            tab === item.id ? 'text-emerald-400' : 'text-zinc-600 hover:text-zinc-400'
          }`}
        >
          {item.icon}
          <span className="text-[10px] font-medium">{item.label}</span>
          {item.id === 'alerts' && alertCount > 0 && (
            <span className="absolute top-2 right-[20%] min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1">
              {alertCount > 9 ? '9+' : alertCount}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

type OnboardStep = 'welcome' | 'disclaimer' | 'api-key' | 'security' | 'pin-setup' | 'pin-confirm';

function OnboardingFlow({ onComplete, initialStep = 'welcome' }: { onComplete: () => void; initialStep?: OnboardStep }) {
  const [step, setStep] = useState<OnboardStep>(initialStep);
  const [apiKey, setApiKey] = useState(localStorage.getItem('fortress_api_key') || '');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [tier, setTier] = useState('');
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [setupPin, setSetupPin] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [recoverEmail, setRecoverEmail] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoverMsg, setRecoverMsg] = useState('');
  const [showRecover, setShowRecover] = useState(false);

  useEffect(() => {
    if (window.Capacitor?.isPluginAvailable?.('BiometricAuthNative')) {
      import('@aparajita/capacitor-biometric-auth').then(({ BiometricAuth }) => {
        BiometricAuth.checkBiometry().then((r) => setBiometricAvail(r.isAvailable)).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  const verifyKey = async () => {
    if (!apiKey.trim()) return;
    setVerifying(true);
    setVerifyError('');
    localStorage.setItem('fortress_api_key', apiKey.trim());
    try {
      const data = await apiFetch('/api/auth/verify');
      setTier(data.tier);
      if (IS_ELECTRON) {
        onComplete();
      } else {
        setStep('security');
      }
    } catch {
      localStorage.removeItem('fortress_api_key');
      setVerifyError('Invalid API key. Use "Recover my key" below if you forgot it.');
    } finally {
      setVerifying(false);
    }
  };

  const recoverKey = async () => {
    if (!recoverEmail.trim()) return;
    setRecovering(true);
    setRecoverMsg('');
    try {
      const SERVER = 'https://fortress-options.onrender.com';
      const res = await fetch(`${SERVER}/api/auth/recover?email=${encodeURIComponent(recoverEmail.trim())}`);
      if (res.ok) {
        setRecoverMsg('Check your email — your API key has been sent.');
      } else {
        const err = await res.json().catch(() => ({}));
        setRecoverMsg(err.detail || 'No subscription found for that email.');
      }
    } catch {
      setRecoverMsg('Could not connect. Try again shortly.');
    } finally {
      setRecovering(false);
    }
  };

  const chooseBiometrics = async () => {
    try {
      const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
      await BiometricAuth.authenticate({ reason: 'Verify your fingerprint to continue', cancelTitle: 'Use PIN instead' });
      localStorage.setItem('fortress_use_biometric', 'true');
      if (!localStorage.getItem('fortress_pin')) localStorage.setItem('fortress_pin', 'biometric');
      onComplete();
    } catch {
      setStep('pin-setup');
    }
  };

  const handlePinDigit = (d: string) => {
    if (step === 'pin-setup') {
      const next = setupPin + d;
      if (next.length === 4) {
        setSetupPin(next);
        setPin('');
        setPinError('');
        setTimeout(() => setStep('pin-confirm'), 150);
      } else {
        setSetupPin(next);
      }
    } else if (step === 'pin-confirm') {
      const next = pin + d;
      if (next.length === 4) {
        if (next === setupPin) {
          localStorage.setItem('fortress_pin', next);
          onComplete();
        } else {
          setPinError("PINs don't match — try again");
          setTimeout(() => { setPin(''); setSetupPin(''); setPinError(''); setStep('pin-setup'); }, 800);
        }
      } else {
        setPin(next);
      }
    }
  };

  const handlePinBack = () => {
    if (step === 'pin-setup') setSetupPin(p => p.slice(0, -1));
    else setPin(p => p.slice(0, -1));
  };

  // Keyboard support for PIN steps
  const handlePinDigitRef = useRef(handlePinDigit);
  const handlePinBackRef = useRef(handlePinBack);
  handlePinDigitRef.current = handlePinDigit;
  handlePinBackRef.current = handlePinBack;
  useEffect(() => {
    if (step !== 'pin-setup' && step !== 'pin-confirm') return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) handlePinDigitRef.current(e.key);
      else if (e.key === 'Backspace') handlePinBackRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const digits = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  if (step === 'welcome') return (
    <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col items-center justify-center px-8 gap-6">
      <div className="w-20 h-20 bg-emerald-500 rounded-3xl flex items-center justify-center shadow-[0_0_48px_rgba(16,185,129,0.5)]">
        <Shield className="w-11 h-11 text-black" />
      </div>
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white tracking-tight">Fortress Options</h1>
        <p className="text-zinc-500 mt-2 text-sm leading-relaxed">
          Institutional-grade options plays, scored and filtered for high-probability setups.
        </p>
      </div>
      {/* Feature highlights */}
      <div className="w-full space-y-2.5">
        {[
          { icon: <Target className="w-4 h-4 text-emerald-400" />, text: 'AI-scored bull put spreads, 0–10 rating' },
          { icon: <CalendarDays className="w-4 h-4 text-emerald-400" />, text: 'Earnings calendar with options plays' },
          { icon: <Bell className="w-4 h-4 text-emerald-400" />, text: 'Instant push alerts for new plays' },
          { icon: <BarChart2 className="w-4 h-4 text-emerald-400" />, text: 'Position tracker with P&L monitoring' },
        ].map((f, i) => (
          <div key={i} className="flex items-center gap-3 bg-zinc-900/60 rounded-xl px-4 py-2.5 border border-zinc-800/60">
            {f.icon}
            <span className="text-zinc-300 text-sm">{f.text}</span>
          </div>
        ))}
      </div>
      <button
        onClick={() => setStep('disclaimer')}
        className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-lg rounded-2xl transition-colors shadow-[0_0_24px_rgba(16,185,129,0.3)]"
      >
        Get Started
      </button>
      <p className="text-zinc-600 text-xs text-center">
        Need a key? Subscribe at <span className="text-emerald-500">fortress-options.com</span>
      </p>
    </div>
  );

  if (step === 'disclaimer') return (
    <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col px-6 pt-12 pb-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 bg-yellow-500/10 rounded-2xl flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-yellow-400" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-white">Risk Disclaimer</h2>
          <p className="text-zinc-500 text-xs mt-0.5">Please read before continuing</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 mb-6 pr-1">
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-2xl p-4">
          <p className="text-yellow-400 text-xs font-bold uppercase tracking-wider mb-2">⚠️ Not Financial Advice</p>
          <p className="text-zinc-300 text-sm leading-relaxed">
            Fortress Options is an <span className="text-white font-semibold">informational tool only</span>. Nothing in this app constitutes financial advice, investment advice, or a recommendation to buy or sell any security.
          </p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4 space-y-3">
          <div>
            <p className="text-white text-sm font-semibold mb-1">📉 Options Trading Risk</p>
            <p className="text-zinc-400 text-[13px] leading-relaxed">Options trading involves substantial risk and is not appropriate for all investors. You can lose your entire investment. Never trade with money you cannot afford to lose.</p>
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <p className="text-white text-sm font-semibold mb-1">🤖 AI-Generated Signals</p>
            <p className="text-zinc-400 text-[13px] leading-relaxed">Play scores and AI analysis are generated algorithmically based on historical and real-time market data. Past performance of signals does not guarantee future results.</p>
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <p className="text-white text-sm font-semibold mb-1">📋 Your Responsibility</p>
            <p className="text-zinc-400 text-[13px] leading-relaxed">You are solely responsible for your own trading decisions. Always conduct your own research, understand the strategy fully, and consult a licensed financial advisor if needed.</p>
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <p className="text-white text-sm font-semibold mb-1">⚡ Market Risks</p>
            <p className="text-zinc-400 text-[13px] leading-relaxed">Markets can move against your position rapidly due to earnings, news, or macro events. Bull put spreads, while defined-risk, can result in maximum loss if the underlying drops sharply.</p>
          </div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/50 rounded-2xl p-3">
          <p className="text-zinc-500 text-[11px] text-center leading-relaxed">
            By continuing, you confirm you are 18+ years old, understand options trading risk, and agree to the{' '}
            <span className="text-emerald-400">Terms of Service</span> and{' '}
            <span className="text-emerald-400">Privacy Policy</span> at fortress-options.com.
          </p>
        </div>
      </div>

      <div className="space-y-3 shrink-0">
        <button
          onClick={() => setStep('api-key')}
          className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-base rounded-2xl transition-colors shadow-[0_0_24px_rgba(16,185,129,0.25)]"
        >
          I Understand & Agree
        </button>
        <button
          onClick={() => setStep('welcome')}
          className="w-full py-3 text-zinc-500 text-sm font-medium"
        >
          Go Back
        </button>
      </div>
    </div>
  );

  if (step === 'api-key') return (
    <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col px-6 pt-14 gap-6">
      <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl flex items-center justify-center">
        <KeyRound className="w-6 h-6 text-emerald-400" />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-white">Enter Your API Key</h2>
        <p className="text-zinc-500 text-sm mt-1">You received this by email after subscribing.</p>
      </div>
      <div>
        <input
          value={apiKey}
          onChange={e => { setApiKey(e.target.value); setVerifyError(''); }}
          placeholder="frt_xxxxxxxxxxxxxxxxxxxx"
          className="w-full bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3.5 text-white font-mono text-sm placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {verifyError && <p className="text-red-400 text-sm mt-2">{verifyError}</p>}
        {tier && <p className="text-emerald-400 text-sm mt-2 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Verified — {tier.charAt(0).toUpperCase() + tier.slice(1)} plan</p>}
      </div>
      <button
        onClick={verifyKey}
        disabled={verifying || !apiKey.trim()}
        className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-black font-bold rounded-2xl transition-colors flex items-center justify-center gap-2"
      >
        {verifying ? <><Loader2 className="w-5 h-5 animate-spin" /> Verifying…</> : 'Verify & Continue'}
      </button>

      {/* Key recovery */}
      <div className="mt-2">
        {!showRecover ? (
          <button
            onClick={() => setShowRecover(true)}
            className="w-full py-2 text-zinc-500 text-sm hover:text-zinc-300 transition-colors"
          >
            Lost your key? Recover it
          </button>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <p className="text-zinc-400 text-sm">Enter your subscription email and we'll resend your key.</p>
            <input
              value={recoverEmail}
              onChange={e => { setRecoverEmail(e.target.value); setRecoverMsg(''); }}
              placeholder="your@email.com"
              type="email"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white text-sm placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
            />
            {recoverMsg && (
              <p className={`text-sm ${recoverMsg.includes('sent') ? 'text-emerald-400' : 'text-red-400'}`}>
                {recoverMsg}
              </p>
            )}
            <button
              onClick={recoverKey}
              disabled={recovering || !recoverEmail.trim()}
              className="w-full py-3 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {recovering ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : 'Send My Key'}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (step === 'security') return (
    <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col px-6 pt-14 gap-6">
      <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl flex items-center justify-center">
        <Lock className="w-6 h-6 text-emerald-400" />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-white">Secure Your App</h2>
        <p className="text-zinc-500 text-sm mt-1">Choose how you want to unlock the app each time.</p>
      </div>
      <div className="flex flex-col gap-3 mt-2">
        {biometricAvail && (
          <button
            onClick={chooseBiometrics}
            className="w-full py-5 bg-zinc-900 border border-zinc-700 hover:border-emerald-500/50 rounded-2xl flex items-center gap-4 px-5 transition-colors"
          >
            <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center shrink-0">
              <Fingerprint className="w-6 h-6 text-emerald-400" />
            </div>
            <div className="text-left">
              <p className="text-white font-semibold">Biometrics</p>
              <p className="text-zinc-500 text-sm">Use fingerprint or face ID</p>
            </div>
          </button>
        )}
        <button
          onClick={() => setStep('pin-setup')}
          className="w-full py-5 bg-zinc-900 border border-zinc-700 hover:border-emerald-500/50 rounded-2xl flex items-center gap-4 px-5 transition-colors"
        >
          <div className="w-10 h-10 bg-zinc-800 rounded-xl flex items-center justify-center shrink-0">
            <Lock className="w-5 h-5 text-zinc-300" />
          </div>
          <div className="text-left">
            <p className="text-white font-semibold">PIN Code</p>
            <p className="text-zinc-500 text-sm">Set a 4-digit PIN</p>
          </div>
        </button>
      </div>
    </div>
  );

  // PIN setup / confirm
  const currentLen = step === 'pin-setup' ? setupPin.length : pin.length;
  const pinTitle = step === 'pin-setup' ? 'Create Your PIN' : 'Confirm Your PIN';
  const pinSubtitle = step === 'pin-setup' ? 'Choose a 4-digit PIN to secure the app' : 'Enter your PIN again to confirm';

  return (
    <div className="fixed inset-0 z-[100] bg-[#0A0A0B] flex flex-col items-center justify-center gap-8">
      <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-[0_0_32px_rgba(16,185,129,0.4)]">
        <Shield className="w-9 h-9 text-black" />
      </div>
      <div>
        <h1 className="text-2xl font-bold text-white text-center">{pinTitle}</h1>
        <p className="text-sm text-zinc-500 text-center mt-1">{pinSubtitle}</p>
      </div>
      <div className="flex gap-4">
        {[0,1,2,3].map(i => (
          <div key={i} className={`w-4 h-4 rounded-full border-2 transition-all ${
            i < currentLen ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'
          }`} />
        ))}
      </div>
      {pinError && <p className="text-red-400 text-sm">{pinError}</p>}
      <div className="grid grid-cols-3 gap-3 w-64">
        {digits.map((d, i) => (
          d === '' ? <div key={i} /> :
          <button
            key={i}
            onClick={() => d === '⌫' ? handlePinBack() : handlePinDigit(d)}
            className="h-16 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 rounded-2xl text-white text-xl font-semibold transition-colors border border-zinc-800"
          >
            {d}
          </button>
        ))}
      </div>
      {biometricAvail && (
        <button onClick={() => setStep('security')} className="text-zinc-600 text-sm">
          ← Back to security options
        </button>
      )}
    </div>
  );
}

// ─── Stock Split Types & Hook ─────────────────────────────────────────────────

interface SplitEvent {
  symbol: string;
  ratio: number;
  date: string;
  days_away: number;
  type: 'upcoming' | 'recent';
}

function useSplits() {
  const [splits, setSplits] = useState<SplitEvent[]>([]);

  useEffect(() => {
    apiFetch('/api/splits')
      .then((d: { splits: SplitEvent[] }) => {
        if (Array.isArray(d.splits) && d.splits.length > 0) {
          // Filter out ones already dismissed this session
          const dismissed = JSON.parse(localStorage.getItem('fortress_dismissed_splits') || '[]') as string[];
          setSplits(d.splits.filter(s => !dismissed.includes(`${s.symbol}-${s.date}`)));
        }
      })
      .catch(() => {});
  }, []);

  const dismiss = (symbol: string, date: string) => {
    const key = `${symbol}-${date}`;
    const dismissed = JSON.parse(localStorage.getItem('fortress_dismissed_splits') || '[]') as string[];
    if (!dismissed.includes(key)) {
      localStorage.setItem('fortress_dismissed_splits', JSON.stringify([...dismissed, key]));
    }
    setSplits(prev => prev.filter(s => !(s.symbol === symbol && s.date === date)));
  };

  return { splits, dismiss };
}

// ─── Stock Split Banner ───────────────────────────────────────────────────────

function SplitBanner({ splits, onDismiss }: { splits: SplitEvent[]; onDismiss: (symbol: string, date: string) => void }) {
  if (splits.length === 0) return null;

  return (
    <div className="shrink-0 space-y-0">
      {splits.map(s => {
        const [num, den] = s.ratio >= 1
          ? [Math.round(s.ratio), 1]
          : [1, Math.round(1 / s.ratio)];
        const ratioLabel = s.ratio >= 1 ? `${num}:${den}` : `1:${Math.round(1 / s.ratio)}`;
        const isUpcoming = s.type === 'upcoming';
        const dateLabel = s.days_away === 0 ? 'Today' :
          s.days_away === 1 ? 'Tomorrow' :
          isUpcoming ? `In ${s.days_away} days` :
          `${Math.abs(s.days_away)}d ago`;

        return (
          <div
            key={`${s.symbol}-${s.date}`}
            className={`flex items-center justify-between px-4 py-2 border-b ${
              isUpcoming
                ? 'bg-yellow-500/10 border-yellow-500/30'
                : 'bg-zinc-800/60 border-zinc-700/40'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base">✂️</span>
              <div className="min-w-0">
                <span className={`text-xs font-bold ${isUpcoming ? 'text-yellow-300' : 'text-zinc-300'}`}>
                  {s.symbol} {ratioLabel} Stock Split
                </span>
                <span className="text-[10px] text-zinc-500 ml-2">
                  {isUpcoming ? '⚡ Upcoming' : '📅 Recent'} · {dateLabel} ({s.date})
                </span>
              </div>
            </div>
            <button
              onClick={() => onDismiss(s.symbol, s.date)}
              className="shrink-0 ml-2 text-zinc-600 hover:text-zinc-400 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tablet Components ────────────────────────────────────────────────────────

/** Upgrade banner shown to Basic-tier users on tablet */
function TabletUpgradeBanner() {
  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-emerald-500/10 to-zinc-900/50 border-b border-emerald-500/20">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-white leading-tight">Tablet Layout Available</p>
        <p className="text-xs text-zinc-400 mt-0.5 leading-snug">
          Upgrade to Pro or Elite for the full tablet experience — side-by-side plays &amp; positions, expanded score breakdowns, and more.
        </p>
      </div>
      <a
        href="https://fortress-options.com/#pricing"
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 px-4 py-2 bg-emerald-500 text-black font-bold text-xs rounded-xl"
      >
        Upgrade
      </a>
    </div>
  );
}

/** Expanded play card for tablet — shows score breakdown bars + AI insight preview */
function TabletPlayCard({ play, onTrack, onViewReasoning }: { play: Play; onTrack: (p: Play) => void; onViewReasoning: (p: Play) => void }) {
  const returnPct = ((play.net_credit / play.spread_width) * 100).toFixed(1);
  const isHotCard = play.score >= 8;
  const isBearCall = play.play_type === 'bear_call';
  const isIronCondor = play.play_type === 'iron_condor';
  const bd: Record<string, number> = play.score_breakdown ? JSON.parse(play.score_breakdown) : {};

  const breakdownItems = [
    { label: 'Premium', value: bd.premium_ratio ?? 0, max: 3 },
    { label: 'Buffer',  value: bd.buffer         ?? 0, max: 2 },
    { label: 'Liquid',  value: bd.liquidity       ?? 0, max: 2 },
    { label: 'DTE',     value: bd.dte             ?? 0, max: 2 },
    { label: 'IV',      value: bd.iv              ?? 0, max: 1 },
  ];
  const hasBreakdown = Object.keys(bd).length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-[#161618] rounded-2xl p-4 cursor-pointer active:scale-[0.99] transition-all ${
        isHotCard ? 'border border-emerald-500/50' : 'border border-zinc-800/80'
      }`}
      style={isHotCard ? { boxShadow: '0 0 28px rgba(16,185,129,0.18), 0 0 0 1px rgba(16,185,129,0.3)' } : undefined}
      onClick={() => onViewReasoning(play)}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xl font-bold text-white">{play.symbol}</span>
            <ScoreBadge score={play.score} />
            {play.is_active === 1
              ? <span className="text-[10px] text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full font-medium">Latest</span>
              : <span className="text-[10px] text-zinc-500 bg-zinc-800 border border-zinc-700/50 px-2 py-0.5 rounded-full font-medium">Earlier Today</span>}
            {isBearCall && <span className="text-[10px] text-sky-400 bg-sky-400/10 border border-sky-400/20 px-2 py-0.5 rounded-full font-medium">Bear Call</span>}
            {isIronCondor && <span className="text-[10px] text-purple-400 bg-purple-400/10 border border-purple-400/20 px-2 py-0.5 rounded-full font-medium">Iron Condor</span>}
            {play.play_type === 'earnings' && <span className="text-[10px] text-orange-400 bg-orange-400/10 border border-orange-400/20 px-2 py-0.5 rounded-full font-medium">Earnings</span>}
          </div>
          <p className="text-sm text-zinc-500 mt-0.5">${play.current_price.toFixed(2)} current</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-emerald-400">${play.net_credit.toFixed(2)}</p>
          <p className="text-[10px] text-zinc-500">per share</p>
        </div>
      </div>

      {/* Expiration */}
      <div className="flex items-center justify-between bg-zinc-900 border border-zinc-700/50 rounded-xl px-3 py-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Expires</span>
          <span className="text-sm font-semibold text-white">{formatExpiration(play.expiration, play.dte)}</span>
        </div>
        {play.found_at && (
          <div className="flex items-center gap-1 bg-zinc-800 rounded-lg px-2 py-0.5">
            <Clock className="w-2.5 h-2.5 text-emerald-500" />
            <span className="text-[11px] font-medium text-zinc-300">{formatFoundAt(play.found_at)}</span>
          </div>
        )}
      </div>

      {/* Strikes */}
      <div className="bg-zinc-900/60 rounded-xl p-3 mb-3 space-y-1.5">
        {isIronCondor ? (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Sell put / buy put</span>
              <span className="font-mono font-semibold text-emerald-400">${play.short_strike} / ${bd.put_long ?? (play.short_strike - 5)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Sell call / buy call</span>
              <span className="font-mono font-semibold text-sky-400">${bd.call_short ?? play.long_strike} / ${bd.call_long ?? (play.long_strike + 5)}</span>
            </div>
            <div className="flex justify-between text-[11px] text-zinc-500 pt-0.5 border-t border-zinc-700/40">
              <span>Profit zone</span>
              <span className="text-purple-300">${play.short_strike} – ${play.long_strike}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Sell (short {isBearCall ? 'call' : 'put'})</span>
              <span className={`font-mono font-semibold ${isBearCall ? 'text-red-400' : 'text-emerald-400'}`}>
                ${play.short_strike} {isBearCall ? 'Call' : 'Put'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Buy (long {isBearCall ? 'call' : 'put'})</span>
              <span className={`font-mono font-semibold ${isBearCall ? 'text-orange-400' : 'text-red-400'}`}>
                ${play.long_strike} {isBearCall ? 'Call' : 'Put'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-2 mb-3">
        <StatPill label="Buffer"   value={`${play.buffer_pct.toFixed(1)}%`} />
        <StatPill label="Return"   value={`${returnPct}%`} />
        <StatPill label="Max Risk" value={`$${play.max_risk.toFixed(0)}`} />
        <StatPill label="IV"       value={`${(play.iv * 100).toFixed(0)}%`} dim />
        <StatPill label="Volume"   value={`${play.volume || 0}`} dim />
        <StatPill label="OI"       value={`${play.open_interest || 0}`} dim />
      </div>

      {/* Score breakdown bars — tablet-exclusive */}
      {hasBreakdown && (
        <div className="mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-2">Score Breakdown</p>
          <div className="space-y-1.5">
            {breakdownItems.map(item => (
              <div key={item.label} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 w-14 shrink-0">{item.label}</span>
                <div className="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all"
                    style={{ width: `${Math.min(100, item.max > 0 ? (item.value / item.max) * 100 : 0)}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-zinc-300 w-8 text-right shrink-0">{item.value}/{item.max}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI insight preview — tablet-exclusive */}
      {play.ai_analysis && (
        <div className="mb-3 bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1.5">🤖 AI Insight</p>
          <p className="text-[11px] text-zinc-400 leading-relaxed line-clamp-3">
            {play.ai_analysis.replace(/\*\*/g, '').slice(0, 220)}{play.ai_analysis.length > 220 ? '…' : ''}
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={e => { e.stopPropagation(); onViewReasoning(play); }}
          className="flex-none px-3 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold rounded-xl transition-colors border border-zinc-700/50"
        >
          Full Analysis
        </button>
        <button
          onClick={e => { e.stopPropagation(); onTrack(play); }}
          className={`flex-1 py-3 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-black font-bold text-sm rounded-xl transition-colors ${play.score >= 8 ? 'animate-pulse' : ''}`}
          style={play.score >= 8 ? { boxShadow: '0 0 18px 5px rgba(16,185,129,0.55)' } : undefined}
        >
          {play.score >= 8 ? '🔥 Track Trade' : 'Track Trade'}
        </button>
      </div>
    </motion.div>
  );
}

/** Left panel of the tablet layout — plays with expanded cards */
function TabletPlaysPanel({
  plays, loading, scanning, marketOpen, onTrack, onViewReasoning, onRefresh,
}: {
  plays: Play[];
  loading: boolean;
  scanning: boolean;
  marketOpen: boolean;
  onTrack: (p: Play) => void;
  onViewReasoning: (p: Play) => void;
  onRefresh: () => void;
}) {
  const lastScan = plays.reduce((best, p) => (!p.found_at ? best : (!best || p.found_at > best ? p.found_at : best)), '' as string);
  const lastScanLabel = lastScan ? `Last scan ${formatFoundAt(lastScan)}` : null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 sticky top-0 bg-[#0A0A0B]/90 backdrop-blur-sm z-10 border-b border-zinc-800/50">
        <div>
          <h2 className="text-sm font-bold text-white">Ranked Plays</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-xs text-zinc-500">{plays.length} found · newest first</p>
            {lastScanLabel && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                <Clock className="w-2.5 h-2.5" />
                {lastScanLabel}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={!marketOpen || scanning}
          title={!marketOpen ? 'Market closed — scanner pauses until 9:30 AM ET' : undefined}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm transition-colors ${
            !marketOpen || scanning
              ? 'bg-zinc-800/50 text-zinc-600 cursor-not-allowed'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scanning || loading ? 'animate-spin text-emerald-400' : ''}`} />
          {scanning ? 'Scanning…' : !marketOpen ? 'Closed' : 'Scan'}
        </button>
      </div>

      {loading && plays.length === 0 ? (
        <LoadingSkeleton />
      ) : plays.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-zinc-600 gap-3 px-6 text-center">
          {isMarketJustOpened() ? (
            <>
              <div className="relative">
                <Target className="w-14 h-14 opacity-20" />
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 animate-ping" />
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500" />
              </div>
              <p className="font-semibold text-zinc-400">Scanning for plays…</p>
              <p className="text-sm text-zinc-500 max-w-xs leading-relaxed">
                Market just opened at 9:30 AM ET. Plays appear once liquidity settles.
              </p>
            </>
          ) : (
            <>
              <Target className="w-14 h-14 opacity-20" />
              <p className="font-medium text-zinc-500">{isMarketOpen() ? 'No plays found' : 'Market is closed'}</p>
              <p className="text-sm text-zinc-600">{isMarketOpen() ? 'Tap Scan to check the market' : 'Scanner runs Mon–Fri 9:30 AM – 4:00 PM ET'}</p>
            </>
          )}
        </div>
      ) : (
        <div className="px-4 py-4 space-y-4">
          {plays.map(p => (
            <TabletPlayCard key={p.id} play={p} onTrack={onTrack} onViewReasoning={onViewReasoning} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Two-column tablet layout for Pro/Elite users */
function TabletLayout({
  plays, positions, history, alerts, loading, scanning, marketOpen,
  tab, setTab, unreadAlerts,
  onTrack, onViewReasoning, onRefresh, onLoadAll,
  onRecommend, onClose, onAck, onDelete, onClearAlerts,
}: {
  plays: Play[];
  positions: Position[];
  history: Position[];
  alerts: Alert[];
  loading: boolean;
  scanning: boolean;
  marketOpen: boolean;
  tab: Tab;
  setTab: (t: Tab) => void;
  unreadAlerts: number;
  onTrack: (p: Play) => void;
  onViewReasoning: (p: Play) => void;
  onRefresh: () => void;
  onLoadAll: () => void;
  onRecommend: (p: Position) => void;
  onClose: (p: Position) => void;
  onAck: (id: number) => void;
  onDelete: (id: number) => void;
  onClearAlerts: () => void;
}) {
  // Left pane always shows plays; right pane shows secondary tabs
  const rightTab: Tab = tab === 'plays' ? 'positions' : tab;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Left: Plays (55%) */}
      <div className="w-[55%] flex flex-col border-r border-zinc-800/80 overflow-hidden">
        <TabletPlaysPanel
          plays={plays} loading={loading} scanning={scanning} marketOpen={marketOpen}
          onTrack={onTrack} onViewReasoning={onViewReasoning} onRefresh={onRefresh}
        />
      </div>

      {/* Right: Secondary panel (45%) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Right pane tab switcher */}
        <div className="shrink-0 flex items-center gap-1 px-3 py-2 bg-[#0D0D0E] border-b border-zinc-800/80">
          {(['positions', 'history', 'earnings', 'alerts'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize ${
                rightTab === t ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t}
              {t === 'alerts' && unreadAlerts > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-1">
                  {unreadAlerts}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Right pane content */}
        <AnimatePresence mode="wait">
          {rightTab === 'positions' && (
            <motion.div key="t-pos" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
              <PositionsScreen positions={positions} loading={loading} onRefresh={onLoadAll} onRecommend={onRecommend} onClose={onClose} />
            </motion.div>
          )}
          {rightTab === 'history' && (
            <motion.div key="t-hist" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
              <HistoryScreen history={history} loading={loading} />
            </motion.div>
          )}
          {rightTab === 'earnings' && (
            <motion.div key="t-earn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
              <EarningsScreen />
            </motion.div>
          )}
          {rightTab === 'alerts' && (
            <motion.div key="t-alrt" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
              <AlertsScreen alerts={alerts} loading={loading} onAck={onAck} onDelete={onDelete} onClearAll={onClearAlerts} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const hasApiKey = !!localStorage.getItem('fortress_api_key');
  const hasPin = !!localStorage.getItem('fortress_pin');
  // Desktop skips PIN requirement — API key alone is sufficient
  const [setupDone, setSetupDone] = useState(IS_ELECTRON ? hasApiKey : (hasApiKey && hasPin));
  const onboardStart: OnboardStep = hasApiKey && !hasPin ? 'security' : 'welcome';
  const [locked, setLocked] = useState(!IS_ELECTRON);
  const lastActivity = useRef(Date.now());
  const [tab, setTab] = useState<Tab>('plays');
  const [dark, setDark] = useState(() => localStorage.getItem('fortress_theme') !== 'light');
  const toggleTheme = () => setDark(prev => {
    const next = !prev;
    localStorage.setItem('fortress_theme', next ? 'dark' : 'light');
    return next;
  });

  // ── Update check ─────────────────────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; download: string; changelog: string } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    const checkVersion = () => {
      fetch('https://fortress-options.com/version.json')
        .then(r => r.json())
        .then(data => {
          if (data.latest && data.latest !== CURRENT_VERSION) {
            setUpdateInfo({ latest: data.latest, download: data.download, changelog: data.changelog || '' });
          }
        })
        .catch(() => {});
    };
    checkVersion();
    const iv = setInterval(checkVersion, 30 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);
  const [plays, setPlays] = useState<Play[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [history, setHistory] = useState<Position[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [trackPlay, setTrackPlay] = useState<Play | null>(null);
  const [reasoningPlay, setReasoningPlay] = useState<Play | null>(null);
  const [recommendPos, setRecommendPos] = useState<Position | null>(null);
  const [closePos, setClosePos] = useState<Position | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pushAnalysis, setPushAnalysis] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [playsData, posData, histData, alertData, statData] = await Promise.allSettled([
      apiFetch('/api/plays'),
      apiFetch('/api/positions'),
      apiFetch('/api/positions/history'),
      apiFetch('/api/alerts'),
      apiFetch('/api/status'),
    ]);
    if (playsData.status === 'fulfilled') {
      setPlays(playsData.value);
      // Write top play to Capacitor Preferences so the home screen widget can read it,
      // then kick the native WidgetUpdater plugin so the widget redraws now instead of
      // waiting up to 30 minutes for the system's updatePeriodMillis timer.
      const top = playsData.value?.[0];
      if (top) {
        try {
          await window.Capacitor?.Plugins?.Preferences?.set({ key: 'fortress_top_play', value: JSON.stringify({ symbol: top.symbol, score: top.score }) });
          window.Capacitor?.Plugins?.WidgetUpdater?.refresh?.();
        } catch {}
      }
    } else {
      // Fail loud: a /api/plays failure was silently swallowed for months and
      // looked exactly like "no plays today" to the user. Show a toast so
      // they (and we) know it's a network/server problem, not an empty feed.
      const reason = (playsData as PromiseRejectedResult).reason;
      const msg = (reason && (reason as Error).message) || 'unknown error';
      console.error('[Fortress] /api/plays failed:', reason);
      showToast(`Couldn't load plays — ${msg.slice(0, 80)}`);
    }
    if (posData.status === 'fulfilled') setPositions(posData.value);
    if (histData.status === 'fulfilled') setHistory(histData.value);
    if (alertData.status === 'fulfilled') setAlerts(alertData.value);
    if (statData.status === 'fulfilled') setStatus(statData.value);
    setLoading(false);
  }, []);

  // ── Notification setup ────────────────────────────────────────────────────
  const seenAlertIds = useRef<Set<number>>(new Set());
  const seenPlayIds  = useRef<Set<number>>(new Set());
  const firstPlayLoad = useRef(true);

  useEffect(() => {
    // Create required notification channels (Android 8+ requires this)
    LocalNotifications.createChannel({
      id: 'fortress_plays',
      name: 'Fortress Plays',
      description: 'New options play alerts',
      importance: 5, // IMPORTANCE_HIGH
      sound: 'fortress_alert',
      vibration: true,
      lights: true,
      lightColor: '#10b981',
    }).catch(() => {});
    LocalNotifications.createChannel({
      id: 'fortress_alerts',
      name: 'Fortress Alerts',
      description: 'Position profit/loss alerts',
      importance: 5,
      sound: 'fortress_alert',
      vibration: true,
      lights: true,
      lightColor: '#f59e0b',
    }).catch(() => {});

    // Request local notification permission
    LocalNotifications.requestPermissions().catch(() => {});

    // Register for FCM push notifications
    PushNotifications.requestPermissions().then(result => {
      if (result.receive === 'granted') {
        PushNotifications.register();
      }
    }).catch(() => {});

    // When FCM gives us a token, send it to the backend
    PushNotifications.addListener('registration', async (token) => {
      try {
        const base = 'https://fortress-options.onrender.com';
        const key = localStorage.getItem('fortress_api_key');
        if (key && token.value) {
          await fetch(`${base}/api/fcm/register?token=${encodeURIComponent(token.value)}`, {
            method: 'POST',
            headers: { 'X-API-Key': key },
          });
        }
      } catch {}
    });

    // Handle FCM push received while app is in foreground — show local notification
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      LocalNotifications.schedule({
        notifications: [{
          id: Math.floor(Math.random() * 90000) + 10000,
          title: notification.title || '⚡ Fortress Options',
          body: notification.body || '',
          schedule: { at: new Date(Date.now() + 100) },
          sound: 'fortress_alert',
          smallIcon: 'ic_stat_icon_config_sample',
          iconColor: '#10b981',
        }],
      }).catch(() => {});
    });

    // Handle notification tap (app in background or killed) — FCM
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data as Record<string, string> | undefined;
      if (data?.tab === 'plays') {
        setTab('plays');
      }
      if (data?.analysis) {
        setPushAnalysis(data.analysis);
      }
    });

    // Handle LOCAL notification tap (plays / alerts) — switch to plays tab + refresh
    LocalNotifications.addListener('localNotificationActionPerformed', () => {
      setTab('plays');
      loadAll();
    });

    // Refresh data whenever app comes back to foreground
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadAll();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      PushNotifications.removeAllListeners();
      LocalNotifications.removeAllListeners();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadAll]);

  useEffect(() => {
    // Fire a push notification for each new unacknowledged alert
    const newAlerts = alerts.filter(
      a => !a.acknowledged && !seenAlertIds.current.has(a.id)
    );
    if (newAlerts.length === 0) return;

    newAlerts.forEach(a => seenAlertIds.current.add(a.id));

    const notifications = newAlerts.map((a, i) => ({
      id: 10000 + a.id,
      title: a.alert_type === 'profit'
        ? `📈 ${a.symbol} — Profit Target Hit!`
        : `📉 ${a.symbol} — Loss Alert`,
      body: a.message,
      schedule: { at: new Date(Date.now() + i * 300) },
      sound: 'fortress_alert',
      channelId: 'fortress_alerts',
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: a.alert_type === 'profit' ? '#00c896' : '#ef4444',
    }));

    LocalNotifications.schedule({ notifications }).catch(() => {});
  }, [alerts]);

  useEffect(() => {
    // Skip the very first load (don't notify for plays already there at open)
    if (firstPlayLoad.current) {
      plays.forEach(p => seenPlayIds.current.add(p.id));
      firstPlayLoad.current = false;
      return;
    }

    const newPlays = plays.filter(p => !seenPlayIds.current.has(p.id));
    if (newPlays.length === 0) return;

    newPlays.forEach(p => seenPlayIds.current.add(p.id));

    // Sort best first
    const sorted = [...newPlays].sort((a, b) => b.score - a.score);

    const notifications = sorted.map((p, i) => ({
      id: 20000 + p.id,
      title: p.score >= 8
        ? `🔥 HOT PLAY — ${p.symbol} (${p.score}/10)`
        : `⚡ New Play — ${p.symbol} (${p.score}/10)`,
      body: `$${p.short_strike}/$${p.long_strike} ${p.play_type === 'bear_call' ? 'Call Spread' : 'Put Spread'} · $${p.net_credit.toFixed(2)} credit · ${p.buffer_pct.toFixed(1)}% buffer`,
      schedule: { at: new Date(Date.now() + i * 400) },
      sound: 'fortress_alert',
      channelId: 'fortress_plays',
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: p.score >= 8 ? '#10b981' : '#f59e0b',
      extra: { playId: p.id },
    }));

    LocalNotifications.schedule({ notifications }).catch(() => {});
  }, [plays]);

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 30_000); // full refresh every 30s
    return () => clearInterval(id);
  }, [loadAll]);

  // ── Fast plays-only poll for live updates ─────────────────────────────────
  useEffect(() => {
    const fastId = setInterval(async () => {
      try {
        const data = await apiFetch('/api/plays');
        setPlays(data);
        const top = data?.[0];
        if (top) {
          try {
            await window.Capacitor?.Plugins?.Preferences?.set({ key: 'fortress_top_play', value: JSON.stringify({ symbol: top.symbol, score: top.score }) });
            window.Capacitor?.Plugins?.WidgetUpdater?.refresh?.();
          } catch {}
        }
      } catch {}
    }, 12_000); // check for new plays every 12s
    return () => clearInterval(fastId);
  }, []);

  // ── Inactivity auto-lock (user-configured timeout) ────────────────────────
  useEffect(() => {
    if (locked || IS_ELECTRON) return;
    const savedMinutes = parseInt(localStorage.getItem('fortress_lock_timeout') || '5', 10);
    if (savedMinutes === 0) return; // "Never" — no lock timer
    const TIMEOUT = savedMinutes * 60 * 1000;
    const resetTimer = () => { lastActivity.current = Date.now(); };
    window.addEventListener('touchstart', resetTimer, { passive: true });
    window.addEventListener('mousedown', resetTimer);
    window.addEventListener('keydown', resetTimer);
    const checker = setInterval(() => {
      if (Date.now() - lastActivity.current >= TIMEOUT) setLocked(true);
    }, 10_000); // check every 10 s
    return () => {
      window.removeEventListener('touchstart', resetTimer);
      window.removeEventListener('mousedown', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      clearInterval(checker);
    };
  }, [locked]);

  const handleScan = async () => {
    try {
      await apiFetch('/api/scan', { method: 'POST' });
      showToast('Scan started — refreshing in 30s');
      setTimeout(loadAll, 30_000);
    } catch {
      showToast('Cannot reach server — check Settings');
    }
  };

  const handleTrackConfirm = async (contracts: number, notes: string) => {
    if (!trackPlay) return;
    try {
      await apiFetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ play_id: trackPlay.id, contracts, notes }),
      });
      showToast(`${trackPlay.symbol} added to tracker`);
      setTrackPlay(null);
      loadAll();
    } catch {
      showToast('Failed to track — check connection');
    }
  };

  const handleCloseConfirm = async (exitCredit: number, reason: string) => {
    if (!closePos) return;
    try {
      await apiFetch(`/api/positions/${closePos.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exit_credit: exitCredit, reason }),
      });
      showToast('Position closed');
      setClosePos(null);
      loadAll();
    } catch {
      showToast('Failed to close position');
    }
  };

  const handleAck = async (id: number) => {
    try {
      await apiFetch(`/api/alerts/${id}/ack`, { method: 'POST' });
      setAlerts(prev => prev.map(a => (a.id === id ? { ...a, acknowledged: 1 } : a)));
    } catch {}
  };

  const handleDeleteAlert = async (id: number) => {
    try {
      await apiFetch(`/api/alerts/${id}`, { method: 'DELETE' });
      setAlerts(prev => prev.filter(a => a.id !== id));
    } catch {}
  };

  const handleClearAlerts = async () => {
    try {
      await apiFetch('/api/alerts', { method: 'DELETE' });
      setAlerts([]);
    } catch {}
  };

  const unreadAlerts = alerts.filter(a => !a.acknowledged).length;
  const isOnline = status?.status === 'online';

  // ── Tablet detection + tier ───────────────────────────────────────────────
  const isTablet = useIsTablet();
  const [userTier, setUserTier] = useState<string | null>(null);

  useEffect(() => {
    if (setupDone && !locked) {
      apiFetch('/api/auth/verify').then((d: { tier?: string }) => setUserTier(d.tier ?? null)).catch(() => {});
    }
  }, [setupDone, locked]);

  const isPremiumTablet = isTablet && (userTier === 'pro' || userTier === 'elite');
  const isBasicTablet   = isTablet && userTier === 'basic';

  // ── Stock split notifications ─────────────────────────────────────────────
  const { splits, dismiss: dismissSplit } = useSplits();

  if (!setupDone) return (
    <OnboardingFlow
      initialStep={onboardStart}
      onComplete={() => { setSetupDone(true); setLocked(false); loadAll(); }}
    />
  );

  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />;

  return (
    <ThemeContext.Provider value={{ dark, toggle: toggleTheme }}>
    <div className={`flex flex-col bg-[#0A0A0B] text-zinc-100 overflow-hidden select-none${dark ? '' : ' light-mode'}`} style={{height:'100dvh',paddingTop:'env(safe-area-inset-top)',paddingBottom:'env(safe-area-inset-bottom)'}}>
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-4 py-3 bg-[#0D0D0E] border-b border-zinc-800/80">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-emerald-500 rounded-xl flex items-center justify-center shadow-[0_0_16px_rgba(16,185,129,0.35)]">
            <Shield className="w-5 h-5 text-black" />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none tracking-tight">
              Fortress <span className="text-emerald-400">Options</span>
            </h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={`w-1.5 h-1.5 rounded-full ${
                !isOnline ? 'bg-zinc-600' :
                status?.market_open ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-500'
              }`} />
              <span className="text-[10px] text-zinc-500">
                {!isOnline ? 'Offline' : status?.market_open ? 'Market Open' : 'Market Closed'}
                {status?.scanning && ' · Scanning…'}
              </span>
              {isOnline && (
                <span className="text-[10px] text-zinc-600">
                  · {status?.plays_available ?? 0} plays
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHowTo(true)}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
            title="How to Use"
          >
            <BookOpen className="w-4 h-4 text-zinc-400" />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
          >
            <Settings className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
      </header>

      {/* Update banner — Android only (desktop has its own installer) */}
      {updateInfo && !updateDismissed && !IS_ELECTRON && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/30">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-emerald-400 text-xs font-bold shrink-0">v{updateInfo.latest} available</span>
            {updateInfo.changelog ? <span className="text-zinc-500 text-xs truncate">· {updateInfo.changelog}</span> : null}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <a
              href={updateInfo.download}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-bold text-emerald-400 px-3 py-1 bg-emerald-500/20 rounded-lg"
            >
              Update
            </a>
            <button onClick={() => setUpdateDismissed(true)} className="text-zinc-600 p-0.5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Stock split notifications */}
      <SplitBanner splits={splits} onDismiss={dismissSplit} />

      {/* Upgrade banner for Basic tier on tablet */}
      {isBasicTablet && <TabletUpgradeBanner />}

      {/* Main content — tablet two-column or standard mobile layout */}
      {isPremiumTablet ? (
        <TabletLayout
          plays={plays} positions={positions} history={history} alerts={alerts}
          loading={loading} scanning={status?.scanning ?? false} marketOpen={status?.market_open ?? false}
          tab={tab} setTab={setTab} unreadAlerts={unreadAlerts}
          onTrack={setTrackPlay} onViewReasoning={setReasoningPlay}
          onRefresh={handleScan} onLoadAll={loadAll}
          onRecommend={setRecommendPos} onClose={setClosePos}
          onAck={handleAck} onDelete={handleDeleteAlert} onClearAlerts={handleClearAlerts}
        />
      ) : (
        <>
          {/* Screen */}
          <AnimatePresence mode="wait">
            {tab === 'plays' && (
              <motion.div key="plays" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
                <PlaysScreen plays={plays} loading={loading} scanning={status?.scanning ?? false} marketOpen={status?.market_open ?? false} onTrack={setTrackPlay} onViewReasoning={setReasoningPlay} onRefresh={handleScan} />
              </motion.div>
            )}
            {tab === 'positions' && (
              <motion.div key="positions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
                <PositionsScreen positions={positions} loading={loading} onRefresh={loadAll} onRecommend={setRecommendPos} onClose={setClosePos} />
              </motion.div>
            )}
            {tab === 'earnings' && (
              <motion.div key="earnings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
                <EarningsScreen />
              </motion.div>
            )}
            {tab === 'history' && (
              <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
                <HistoryScreen history={history} loading={loading} />
              </motion.div>
            )}
            {tab === 'alerts' && (
              <motion.div key="alerts" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
                <AlertsScreen alerts={alerts} loading={loading} onAck={handleAck} onDelete={handleDeleteAlert} onClearAll={handleClearAlerts} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bottom Nav */}
          <BottomNav tab={tab} setTab={setTab} alertCount={unreadAlerts} />
        </>
      )}

      {/* Modals */}
      <AnimatePresence>
        {pushAnalysis && (
          <Modal key="push-analysis" onClose={() => setPushAnalysis(null)}>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-xl">🤖</span>
                  <h3 className="text-lg font-bold text-white">Fortress AI Analysis</h3>
                </div>
                <button onClick={() => setPushAnalysis(null)} className="p-1.5 bg-zinc-800 rounded-lg">
                  <X className="w-4 h-4 text-zinc-400" />
                </button>
              </div>
              <div className="space-y-3 text-[13px] text-zinc-300 leading-relaxed">
                {pushAnalysis.split('\n\n').map((block, i) => {
                  const lines = block.split('\n');
                  const heading = lines[0].replace(/\*\*/g, '');
                  const body = lines.slice(1).join(' ');
                  return (
                    <div key={i} className="bg-zinc-900 rounded-xl p-3">
                      <p className="font-bold text-zinc-100 mb-1">{heading}</p>
                      {body && <p className="text-zinc-400">{body}</p>}
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() => { setPushAnalysis(null); setTab('plays'); }}
                className="w-full mt-4 py-3 rounded-xl bg-emerald-500 text-black font-bold text-sm"
              >
                View All Plays
              </button>
            </div>
          </Modal>
        )}
        {reasoningPlay && (
          <PlayReasoningModal
            key="reasoning"
            play={reasoningPlay}
            onClose={() => setReasoningPlay(null)}
            onTrack={p => { setReasoningPlay(null); setTrackPlay(p); }}
          />
        )}
        {trackPlay && (
          <TrackModal key="track" play={trackPlay} onConfirm={handleTrackConfirm} onClose={() => setTrackPlay(null)} />
        )}
        {recommendPos && (
          <RecommendModal key="rec" position={recommendPos} onClose={() => setRecommendPos(null)} />
        )}
        {closePos && (
          <CloseModal key="close" position={closePos} onConfirm={handleCloseConfirm} onClose={() => setClosePos(null)} />
        )}
        {showSettings && (
          <SettingsModal key="settings" onClose={() => setShowSettings(false)} />
        )}
        {showHowTo && (
          <HowToUseModal key="howto" onClose={() => setShowHowTo(false)} />
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ opacity: 0, y: 60 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 60 }}
            className="fixed bottom-24 left-4 right-4 z-50 bg-zinc-800 border border-zinc-700/60 rounded-2xl px-4 py-3 text-sm text-zinc-200 text-center shadow-2xl"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </ThemeContext.Provider>
  );
}
