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
    ...(opts?.headers as Record<string, string> || {}),
    ...(key ? { 'X-API-Key': key } : {}),
  };
  const res = await fetch(`${getBase()}${path}`, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status}`);
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
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function PlayCard({ play, onTrack, onViewReasoning }: { play: Play; onTrack: (p: Play) => void; onViewReasoning: (p: Play) => void }) {
  const returnPct = ((play.net_credit / play.spread_width) * 100).toFixed(1);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[#161618] border border-zinc-800/80 rounded-2xl p-4 cursor-pointer active:scale-[0.99] transition-transform"
      onClick={() => onViewReasoning(play)}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xl font-bold text-white">{play.symbol}</span>
            <ScoreBadge score={play.score} />
            {play.play_type === 'earnings' && (
              <span className="text-[10px] text-orange-400 bg-orange-400/10 border border-orange-400/20 px-2 py-0.5 rounded-full font-medium">
                Earnings
              </span>
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
        <div className="flex justify-between text-sm">
          <span className="text-zinc-400">Sell (short)</span>
          <span className="font-mono font-semibold text-emerald-400">${play.short_strike} Put</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-zinc-400">Buy (long)</span>
          <span className="font-mono font-semibold text-red-400">${play.long_strike} Put</span>
        </div>
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
          <span className="text-xl font-bold text-white">{pos.symbol}</span>
          <p className="text-sm text-zinc-400">
            ${pos.short_strike}/{pos.long_strike} Put Spread
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
  const win = pnl >= 0;
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
        <p className={`font-bold ${win ? 'text-emerald-400' : 'text-red-400'}`}>
          {win ? '+' : ''}{pnl.toFixed(1)}%
        </p>
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

// ─── Recommend Modal ──────────────────────────────────────────────────────────

// ─── Play Reasoning Modal ─────────────────────────────────────────────────────

function PlayReasoningModal({ play, onClose, onTrack }: { play: Play; onClose: () => void; onTrack: (p: Play) => void }) {
  const bd: ScoreBreakdown = play.score_breakdown
    ? JSON.parse(play.score_breakdown)
    : { premium_ratio: 0, buffer: 0, liquidity: 0, dte: 0, iv: 0 };

  const returnPct = ((play.net_credit / play.spread_width) * 100).toFixed(1);
  const isHot = play.score >= 8;

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
        ? `${play.buffer_pct.toFixed(1)}% below current price — strong downside cushion`
        : bd.buffer === 1
        ? `${play.buffer_pct.toFixed(1)}% below current price — moderate buffer`
        : `${play.buffer_pct.toFixed(1)}% below current price — tight, needs close watch`,
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
      <div className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-bold text-white">{play.symbol}</h3>
              <ScoreBadge score={play.score} />
              {play.play_type === 'earnings' && (
                <span className="text-[10px] text-orange-400 bg-orange-400/10 border border-orange-400/20 px-2 py-0.5 rounded-full font-medium">Earnings</span>
              )}
            </div>
            <p className="text-xs text-zinc-500 mt-0.5">${play.short_strike}/${play.long_strike} Put Spread · ${play.net_credit.toFixed(2)} credit</p>
          </div>
          <button onClick={onClose} className="p-1.5 bg-zinc-800 rounded-lg">
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

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

        {/* CTA */}
        <button
          onClick={() => { onClose(); onTrack(play); }}
          className={`w-full py-3 font-bold text-sm rounded-xl transition-colors text-black ${isHot ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-emerald-600 hover:bg-emerald-500'} ${isHot ? 'animate-pulse shadow-[0_0_16px_4px_rgba(16,185,129,0.5)]' : ''}`}
          style={isHot ? { boxShadow: '0 0 18px 5px rgba(16,185,129,0.45)' } : undefined}
        >
          {isHot ? '🔥 Track This Trade' : 'Track This Trade'}
        </button>
      </div>
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

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { dark, toggle: toggleTheme } = useTheme();
  const [apiKey, setApiKey] = useState(localStorage.getItem('fortress_api_key') || '');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState('');
  const [section, setSection] = useState<'connection' | 'security' | 'telegram'>('connection');
  const [tier, setTier] = useState<string | null>(null);
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(localStorage.getItem('fortress_use_biometric') === 'true');

  useEffect(() => {
    apiFetch('/api/auth/verify').then(d => setTier(d.tier)).catch(() => {});
    // @ts-ignore
    if (window.Capacitor?.isPluginAvailable?.('BiometricAuthNative')) {
      import('@aparajita/capacitor-biometric-auth').then(({ BiometricAuth }) => {
        // @ts-ignore
        BiometricAuth.checkBiometry().then((r: any) => setBiometricAvail(r.isAvailable)).catch(() => {});
      }).catch(() => {});
    }
  }, []);

  const saveConnection = () => {
    localStorage.removeItem('fortress_server'); // clear any old local IP
    localStorage.setItem('fortress_api_key', apiKey);
    onClose();
    window.location.reload();
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

        {/* Tabs */}
        <div className="flex bg-zinc-900 rounded-xl p-1 mb-5">
          {(['connection', 'security', 'telegram'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors capitalize ${
                section === s ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s === 'connection' ? 'Connection' : s === 'security' ? 'Security' : '✈ Telegram'}
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

            <div className="flex items-center gap-3 bg-zinc-900 rounded-2xl p-4 mb-5 border border-zinc-800">
              <Lock className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white">PIN Lock</p>
                <p className="text-xs text-zinc-500">App locks automatically after 5 min</p>
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
          </>
        )}

        {section === 'telegram' && (
          <TelegramSection apiKey={apiKey} />
        )}

        {/* Version footer */}
        <p className="text-center text-xs text-zinc-600 mt-6">Fortress Options v1.7.0{tier ? ` · ${tier.charAt(0).toUpperCase() + tier.slice(1)}` : ''}</p>
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
    // @ts-ignore
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
      // @ts-ignore
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
  plays, loading, scanning, onTrack, onViewReasoning, onRefresh,
}: {
  plays: Play[];
  loading: boolean;
  scanning: boolean;
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
            <p className="text-xs text-zinc-500">{plays.length} found · sorted by score</p>
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
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-sm text-zinc-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${scanning || loading ? 'animate-spin text-emerald-400' : ''}`} />
          {scanning ? 'Scanning…' : 'Scan'}
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

function HistoryScreen({ history, loading }: { history: Position[]; loading: boolean }) {
  const wins = history.filter(p => (p.pnl_pct ?? 0) >= 0).length;
  const totalPnl = history.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-3 sticky top-0 bg-[#0A0A0B]/90 backdrop-blur-sm z-10 border-b border-zinc-800/50">
        <h2 className="text-sm font-bold text-white">Trade History</h2>
        <p className="text-xs text-zinc-500">{history.length} closed trades</p>
        {history.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Win Rate</p>
              <p className="font-bold text-white">{history.length ? ((wins / history.length) * 100).toFixed(0) : 0}%</p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">Total P&L</p>
              <p className={`font-bold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}%
              </p>
            </div>
            <div className="bg-zinc-900 rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-zinc-500 uppercase">W / L</p>
              <p className="font-bold text-white">{wins} / {history.length - wins}</p>
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
    fetch('https://fortress-options.com/earnings.json')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.events) && data.events.length > 0) {
          setEvents(data.events.map((e: any) => ({ ...e, tier: 'pro' as const })));
        }
      })
      .catch(() => {})
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

type OnboardStep = 'welcome' | 'api-key' | 'security' | 'pin-setup' | 'pin-confirm';

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

  useEffect(() => {
    // @ts-ignore
    if (window.Capacitor?.isPluginAvailable?.('BiometricAuthNative')) {
      import('@aparajita/capacitor-biometric-auth').then(({ BiometricAuth }) => {
        // @ts-ignore
        BiometricAuth.checkBiometry().then((r: any) => setBiometricAvail(r.isAvailable)).catch(() => {});
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
      setStep('security');
    } catch {
      localStorage.removeItem('fortress_api_key');
      setVerifyError('Invalid API key. Subscribe at fortress-options.com to get yours.');
    } finally {
      setVerifying(false);
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
        onClick={() => setStep('api-key')}
        className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-lg rounded-2xl transition-colors shadow-[0_0_24px_rgba(16,185,129,0.3)]"
      >
        Get Started
      </button>
      <p className="text-zinc-600 text-xs text-center">
        Need a key? Subscribe at <span className="text-emerald-500">fortress-options.com</span>
      </p>
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

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const hasApiKey = !!localStorage.getItem('fortress_api_key');
  const hasPin = !!localStorage.getItem('fortress_pin');
  const [setupDone, setSetupDone] = useState(hasApiKey && hasPin);
  const onboardStart: OnboardStep = hasApiKey && !hasPin ? 'security' : 'welcome';
  const [locked, setLocked] = useState(true);
  const lastActivity = useRef(Date.now());
  const [tab, setTab] = useState<Tab>('plays');
  const [dark, setDark] = useState(() => localStorage.getItem('fortress_theme') !== 'light');
  const toggleTheme = () => setDark(prev => {
    const next = !prev;
    localStorage.setItem('fortress_theme', next ? 'dark' : 'light');
    return next;
  });

  // ── Update check ─────────────────────────────────────────────────────────────
  const CURRENT_VERSION = '1.7.0';
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; download: string; changelog: string } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    fetch('https://fortress-options.com/version.json')
      .then(r => r.json())
      .then(data => {
        if (data.latest && data.latest !== CURRENT_VERSION) {
          setUpdateInfo({ latest: data.latest, download: data.download, changelog: data.changelog || '' });
        }
      })
      .catch(() => {});
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
    if (playsData.status === 'fulfilled') setPlays(playsData.value);
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

    // Handle notification tap (app in background or killed)
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data as Record<string, string> | undefined;
      if (data?.tab === 'plays') {
        setTab('plays');
      }
      if (data?.analysis) {
        setPushAnalysis(data.analysis);
      }
    });

    return () => {
      PushNotifications.removeAllListeners();
    };
  }, []);

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
      body: `$${p.short_strike}/$${p.long_strike} Put Spread · $${p.net_credit.toFixed(2)} credit · ${p.buffer_pct.toFixed(1)}% buffer`,
      schedule: { at: new Date(Date.now() + i * 400) },
      sound: 'fortress_alert',
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: p.score >= 8 ? '#10b981' : '#f59e0b',
      extra: { playId: p.id },
    }));

    LocalNotifications.schedule({ notifications }).catch(() => {});
  }, [plays]);

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 30_000); // poll every 30s for fast play delivery
    return () => clearInterval(id);
  }, [loadAll]);

  // ── Inactivity auto-lock (5 minutes) ──────────────────────────────────────
  useEffect(() => {
    if (locked) return;
    const TIMEOUT = 5 * 60 * 1000; // 5 minutes
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

  if (!setupDone) return (
    <OnboardingFlow
      initialStep={onboardStart}
      onComplete={() => { setSetupDone(true); setLocked(false); loadAll(); }}
    />
  );

  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />;

  return (
    <ThemeContext.Provider value={{ dark, toggle: toggleTheme }}>
    <div className={`h-screen flex flex-col bg-[#0A0A0B] text-zinc-100 overflow-hidden select-none${dark ? '' : ' light-mode'}`}>
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
              <div className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
              <span className="text-[10px] text-zinc-500">
                {isOnline ? 'Connected' : 'Offline'}
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
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
        >
          <Settings className="w-4.5 h-4.5 text-zinc-400" />
        </button>
      </header>

      {/* Update banner */}
      {updateInfo && !updateDismissed && (
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

      {/* Screen */}
      <AnimatePresence mode="wait">
        {tab === 'plays' && (
          <motion.div key="plays" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden flex flex-col">
            <PlaysScreen plays={plays} loading={loading} scanning={status?.scanning ?? false} onTrack={setTrackPlay} onViewReasoning={setReasoningPlay} onRefresh={handleScan} />
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
