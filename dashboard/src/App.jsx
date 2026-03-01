import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Cpu,
  Wallet,
  Play,
  Square,
  Terminal,
  Settings,
  RefreshCcw,
  Zap,
  Shield,
  Server,
  Layers,
  Power,
  CheckCircle2,
  Download,
  AlertTriangle
} from 'lucide-react';

const socket = io(window.location.origin);

function App() {
  const [accounts, setAccounts] = useState([]);
  const [runners, setRunners] = useState({});
  const [nodeHealth, setNodeHealth] = useState({});
  const [mainWalletAddress, setMainWalletAddress] = useState('');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('');
  const [proxyUser, setProxyUser] = useState('');
  const [proxyPass, setProxyPass] = useState('');
  const [proxyMode, setProxyMode] = useState('manual');
  const [editProxy, setEditProxy] = useState(false);
  const [editWallet, setEditWallet] = useState(false);
  const [globalStats, setGlobalStats] = useState({ totalEarned: 0, activeCount: 0 });
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [rescuedWallets, setRescuedWallets] = useState([]);
  const [rescuedTotal, setRescuedTotal] = useState(0);
  const [referralCode, setReferralCode] = useState('');
  const [referralEnabled, setReferralEnabled] = useState(false);
  const [fleetPaused, setFleetPaused] = useState(false);
  const [useFakeIp, setUseFakeIp] = useState(false);
  const [turnstileSolverUrl, setTurnstileSolverUrl] = useState('http://localhost:3000');

  // Config State
  const [activeTab, setActiveTab] = useState('execution');
  const [targetFleet, setTargetFleet] = useState(10);
  const [autoWithdraw, setAutoWithdraw] = useState(false);
  const [withdrawLimit, setWithdrawLimit] = useState('0.00000000');
  // const [mainWalletAddress, setMainWalletAddress] = useState('nano_3bq8i3qeku3busp6p3pqad8o3oorpnq9d3p6n5oeunzqwy7cc8q4dc4satad'); // Moved to new state
  const [defaultProxy, setDefaultProxy] = useState('');

  useEffect(() => {
    socket.on('init', ({ accounts, runners, nodeHealth, settings, rescued }) => {
      setAccounts(accounts);
      const runnerMap = {};
      runners.forEach(r => runnerMap[r.name] = r);
      setRunners(runnerMap);
      if (nodeHealth) setNodeHealth(nodeHealth);
      if (settings) {
        setMainWalletAddress(settings.mainWalletAddress || '');
        setProxyMode(settings.proxyMode || 'brightdata');
        setProxyHost(settings.proxyHost || 'brd.superproxy.io');
        setProxyPort(settings.proxyPort || '33335');
        setProxyUser(settings.proxyUser || '');
        setProxyPass(settings.proxyPass || '');
        setReferralCode(settings.referralCode || '');
        setReferralEnabled(settings.referralEnabled || false);
        setFleetPaused(settings.fleetPaused || false);
        setUseFakeIp(settings.useFakeIp || false);
        setTurnstileSolverUrl(settings.turnstileSolverUrl || 'http://localhost:3000');
      }
      if (rescued) {
        setRescuedWallets(rescued.wallets || []);
        setRescuedTotal(rescued.totalBalance || 0);
      }
    });

    socket.on('settings-updated', (s) => {
      setMainWalletAddress(s.mainWalletAddress || '');
      setProxyMode(s.proxyMode || 'brightdata');
      setProxyHost(s.proxyHost || '');
      setProxyPort(s.proxyPort || '');
      setProxyUser(s.proxyUser || '');
      setProxyPass(s.proxyPass || '');
      setFleetPaused(s.fleetPaused || false);
      setUseFakeIp(s.useFakeIp || false);
      setTurnstileSolverUrl(s.turnstileSolverUrl || 'http://localhost:3000');
    });

    socket.on('runner-status', ({ name, status }) => {
      setRunners(prev => ({ ...prev, [name]: { ...prev[name], status } }));
    });

    socket.on('runner-removed', (name) => {
      setRunners(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    });

    socket.on('sync-state', ({ earnings, proxyWallets, logs: newLogs }) => {
      // Batch earnings updates without crashing React Virtual DOM
      setAccounts(prev => prev.map(a => {
        if (earnings[a.name] !== undefined) {
          return { ...a, earnings: earnings[a.name] };
        }
        return a;
      }));

      // Update proxy wallets in runners state
      if (proxyWallets) {
        setRunners(prev => {
          const next = { ...prev };
          Object.keys(proxyWallets).forEach(name => {
            if (next[name]) next[name].proxyWallet = proxyWallets[name];
          });
          return next;
        });
      }

      // Batch strictly new Mission Logs
      if (newLogs && newLogs.length > 0) {
        setLogs(prev => {
          const transformed = newLogs.map(log => ({ id: Math.random(), name: log.name, msg: log.msg })).reverse();
          return [...transformed, ...prev].slice(0, 20);
        });
      }
    });

    socket.on('node-health', (health) => setNodeHealth(health));

    socket.on('rescue-updated', (data) => {
      setRescuedWallets(data.wallets || []);
      setRescuedTotal(data.totalBalance || 0);
    });

    socket.on('rescue-status', ({ seed, status }) => {
      setRescuedWallets(prev => prev.map(w => w.seed === seed ? { ...w, rescueStatus: status } : w));
    });

    return () => socket.off();
  }, []);

  const startFleet = () => {
    let finalProxy = "";
    if (proxyHost && proxyPort) {
      const auth = (proxyUser && proxyPass) ? `${proxyUser}:${proxyPass}@` : "";
      finalProxy = `http://${auth}${proxyHost}:${proxyPort}`;
    }

    socket.emit('start-fleet', {
      targetSize: targetFleet,
      autoWithdrawEnabled: autoWithdraw,
      withdrawLimit: parseFloat(withdrawLimit) || 0,
      mainWalletAddress,
      defaultProxy: finalProxy,
      useFakeIp
    });
    // setIsRunning(true); // This line was in the instruction but `isRunning` is a derived state, not a state variable. Omitting to prevent error.
  };

  const saveGlobalSettings = () => {
    socket.emit('save-settings', {
      mainWalletAddress,
      proxyMode,
      proxyHost,
      proxyPort,
      proxyUser,
      proxyPass,
      referralCode,
      referralEnabled,
      useFakeIp
    });
    setEditProxy(false);
    setEditWallet(false);
  };

  const stopFleet = () => socket.emit('stop-fleet');
  const sweepAll = () => socket.emit('sweep-all', mainWalletAddress);
  const pauseFleet = () => socket.emit('pause-fleet');
  const resumeFleet = () => socket.emit('resume-fleet');

  const formatNano = (val) => {
    const num = parseFloat(val) || 0;
    return num.toFixed(8);
  };

  const activeRunnersCount = Object.values(runners).filter(r => r.status === 'running' || r.status === 'paused').length;
  const isRunning = activeRunnersCount > 0;

  const totalEarned = accounts.reduce((sum, acc) => sum + (parseFloat(acc.earnings) || 0), 0);

  return (
    <div className="dashboard">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-10"
      >
        <h1 className="title-glow text-5xl mb-2">NANO FLEET COMMAND</h1>
        <div className="flex justify-center gap-4 text-xs font-bold uppercase tracking-widest text-text-dim">
          <span className="flex items-center"><Shield className="size-3 mr-1" color="#00ff88" /> Anonymous Bridge Active</span>
          <span className="flex items-center"><Activity className="size-3 mr-1" color="#00f2ff" /> Auto-Withdraw Engine: Ready</span>
        </div>
      </motion.div>

      <div className="flex justify-center gap-4 mb-8">
        <button
          className={`px-8 py-3 rounded-xl font-black text-sm tracking-widest transition-all ${activeTab === 'execution' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50' : 'bg-white/5 text-text-dim hover:bg-white/10'}`}
          onClick={() => setActiveTab('execution')}
        >
          <Cpu className="inline-block mr-2 size-4" /> Execution Engine
        </button>
        <button
          className={`px-8 py-3 rounded-xl font-black text-sm tracking-widest transition-all ${activeTab === 'wallet' ? 'bg-green-500/20 text-green-400 border border-green-500/50' : 'bg-white/5 text-text-dim hover:bg-white/10'}`}
          onClick={() => setActiveTab('wallet')}
        >
          <Wallet className="inline-block mr-2 size-4" /> Master Wallet Hub
        </button>
        <button
          className={`px-8 py-3 rounded-xl font-black text-sm tracking-widest transition-all relative ${activeTab === 'rescue' ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-white/5 text-text-dim hover:bg-white/10'}`}
          onClick={() => setActiveTab('rescue')}
        >
          <AlertTriangle className="inline-block mr-2 size-4" /> Rescue Vault
          {rescuedWallets.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-black rounded-full w-5 h-5 flex items-center justify-center">{rescuedWallets.length}</span>
          )}
        </button>
      </div>

      <div className="stats-grid mb-8">
        <StatCard icon={<Wallet className="size-6" color="#00f2ff" />} label="Aggregated Yield" value={`${formatNano(totalEarned)} NANO`} />
        <StatCard icon={<Layers className="size-6" color="#00ff88" />} label="Active Workers" value={activeRunnersCount} />
        <StatCard icon={<Zap className="size-6" color="#ffcc00" />} label="Network Pulse" value="~1.2s Latency" />
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'execution' ? (
          <motion.div
            key="execution"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="grid grid-cols-1 lg:grid-cols-3 gap-8"
          >
            {/* CONFIG PANEL */}
            <section className="glass-panel lg:col-span-1 space-y-6">
              <h2 className="text-xl font-black flex items-center border-b border-white/10 pb-4 mb-4">
                <Settings className="mr-3 size-5" color="#00f2ff" /> FLEET CONFIGURATION
              </h2>

              <div>
                <label className="text-xs font-bold text-text-dim mb-2 block uppercase tracking-wider flex justify-between">
                  Target Fleet Size
                  {isRunning && (
                    <span className="text-[9px] text-cyan-400 animate-pulse">Active</span>
                  )}
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    className="input-field flex-1 text-lg font-mono"
                    value={targetFleet}
                    onChange={(e) => setTargetFleet(e.target.value)}
                  />
                  {isRunning && (
                    <button
                      onClick={startFleet}
                      className="px-4 py-2 rounded-lg text-[9px] font-black uppercase bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 hover:bg-cyan-500/30 transition-all flex items-center justify-center glow-cyan"
                      title="Apply new size and restart fleet"
                    >
                      <Power className="mr-1 size-3" /> RESCALE
                    </button>
                  )}
                </div>
              </div>

              {/* PROXY CONFIG */}
              <div className="bg-black/30 p-4 rounded-xl border border-white/5 relative overflow-hidden">
                <div className="flex justify-between items-center mb-4">
                  <label className="text-xs font-bold text-text-dim uppercase tracking-wider">Proxy Configuration</label>
                  <button
                    onClick={() => editProxy ? saveGlobalSettings() : setEditProxy(true)}
                    className={`px-3 py-1 rounded text-[10px] font-bold border transition-all ${editProxy ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-white/5 text-text-dim border-white/10 hover:bg-white/10'}`}
                  >
                    {editProxy ? 'SAVE CONFIG' : 'EDIT'}
                  </button>
                </div>

                {/* Proxy Mode Selector */}
                <div className="flex gap-2 mb-4">
                  <button
                    onClick={() => {
                      if (!editProxy) return;
                      setProxyMode('brightdata');
                      setProxyHost('');
                      setProxyPort('');
                      setProxyUser('');
                      setProxyPass('');
                    }}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black tracking-widest uppercase transition-all border ${proxyMode === 'brightdata'
                      ? 'bg-orange-500/20 text-orange-400 border-orange-500/50'
                      : 'bg-white/5 text-text-dim border-white/10 hover:bg-white/10'
                      }`}
                  >
                    ⚡ BrightData
                  </button>
                  <button
                    onClick={() => {
                      if (!editProxy) return;
                      setProxyMode('manual');
                      setProxyHost('');
                      setProxyPort('');
                      setProxyUser('');
                      setProxyPass('');
                    }}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black tracking-widest uppercase transition-all border ${proxyMode === 'manual'
                      ? 'bg-purple-500/20 text-purple-400 border-purple-500/50'
                      : 'bg-white/5 text-text-dim border-white/10 hover:bg-white/10'
                      }`}
                  >
                    ⚙️ Manual
                  </button>
                </div>

                {/* Fake IP Toggle */}
                <div className="flex items-center justify-between bg-black/40 p-3 rounded-lg border border-white/5 mb-4">
                  <div>
                    <div className="text-[10px] font-bold text-text-dim uppercase tracking-wider mb-1">
                      👻 X-Forwarded-For Fake IP
                    </div>
                    <div className="text-[9px] text-text-dim/60">
                      Spoof headers to bypass rate limits (if proxy is omitted or blocked).
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const next = !useFakeIp;
                      setUseFakeIp(next);
                      socket.emit('save-settings', { ...{ mainWalletAddress, proxyMode, proxyHost, proxyPort, proxyUser, proxyPass, referralCode, referralEnabled, fleetPaused, turnstileSolverUrl, useFakeIp: next } });
                    }}
                    className={`ml-3 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all w-16 text-center ${useFakeIp
                      ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 glow-cyan'
                      : 'bg-white/5 text-text-dim border border-white/10 hover:bg-white/10'
                      }`}
                  >
                    {useFakeIp ? 'ON' : 'OFF'}
                  </button>
                </div>

                {proxyMode === 'brightdata' && (
                  <div className="bg-orange-500/5 border border-orange-500/20 rounded-lg p-3 mb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-orange-400 text-[10px] font-bold uppercase tracking-wider">⚡ BrightData Rotating Proxy</span>
                    </div>
                    <p className="text-[9px] text-text-dim/60 mb-2">Session IDs are auto-injected per worker for unique IPs.</p>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="text-[9px] text-text-dim/60 mb-1 block">HOST</label>
                      <input
                        type="text"
                        placeholder="brd.superproxy.io"
                        className="input-field w-full font-mono text-[11px] py-1.5"
                        value={proxyHost}
                        onChange={(e) => setProxyHost(e.target.value)}
                        disabled={!editProxy || useFakeIp}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[9px] text-text-dim/60 mb-1 block">PORT</label>
                      <input
                        type="text"
                        placeholder="33335"
                        className="input-field w-full font-mono text-[11px] py-1.5"
                        value={proxyPort}
                        onChange={(e) => setProxyPort(e.target.value)}
                        disabled={!editProxy || useFakeIp}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-[2]">
                      <label className="text-[9px] text-text-dim/60 mb-1 block">ZONE USERNAME</label>
                      <input
                        type="text"
                        placeholder="brd-customer-xxxx-zone-xxxx"
                        className="input-field w-full font-mono text-[11px] py-1.5"
                        value={proxyUser}
                        onChange={(e) => setProxyUser(e.target.value)}
                        disabled={!editProxy || useFakeIp}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[9px] text-text-dim/60 mb-1 block">ZONE PASSWORD</label>
                      <input
                        type="password"
                        placeholder="••••••••"
                        className="input-field w-full font-mono text-[11px] py-1.5"
                        value={proxyPass}
                        onChange={(e) => setProxyPass(e.target.value)}
                        disabled={!editProxy || useFakeIp}
                      />
                    </div>
                  </div>
                </div>
                <p className="text-[9px] text-text-dim/40 mt-3 italic leading-tight">
                  {proxyMode === 'brightdata'
                    ? 'Each worker gets a unique session ID (-session-rand_XXXX) for IP isolation.'
                    : 'Enter your custom proxy details. Session injection only applies to BrightData-compatible proxies.'}
                </p>
              </div>

              {/* MASTER WALLET CONFIG */}
              <div className="bg-black/30 p-4 rounded-xl border border-white/5">
                <div className="flex justify-between items-center mb-4">
                  <label className="text-xs font-bold text-text-dim uppercase tracking-wider">Master Wallet Address</label>
                  <button
                    onClick={() => editWallet ? saveGlobalSettings() : setEditWallet(true)}
                    className={`px-3 py-1 rounded text-[10px] font-bold border transition-all ${editWallet ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-white/5 text-text-dim border-white/10 hover:bg-white/10'}`}
                  >
                    {editWallet ? 'SAVE WALLET' : 'EDIT'}
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="nano_..."
                  className="input-field w-full font-mono text-[11px] py-2"
                  value={mainWalletAddress}
                  onChange={(e) => setMainWalletAddress(e.target.value)}
                  disabled={!editWallet}
                />
                <p className="text-[9px] text-text-dim/40 mt-3 italic leading-tight">This address receives all consolidated funds from session proxy wallets.</p>
              </div>

              {/* REFERRAL CODE CONFIG */}
              <div className="bg-black/30 p-4 rounded-xl border border-white/5">
                <div className="flex justify-between items-center mb-4">
                  <label className="text-xs font-bold text-text-dim uppercase tracking-wider flex items-center gap-2">
                    🔗 Referral Code
                    <span className={`text-[9px] px-2 py-0.5 rounded-full font-black tracking-wider ${referralEnabled ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                      {referralEnabled ? 'ACTIVE' : 'OFF'}
                    </span>
                  </label>
                  <button
                    onClick={() => {
                      const next = !referralEnabled;
                      setReferralEnabled(next);
                      socket.emit('save-settings', { ...{ mainWalletAddress, proxyMode, proxyHost, proxyPort, proxyUser, proxyPass, referralCode, referralEnabled: next, fleetPaused, turnstileSolverUrl, useFakeIp } });
                    }}
                    className={`px-3 py-1 rounded text-[10px] font-bold border transition-all ${referralEnabled ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-white/5 text-text-dim border-white/10 hover:bg-white/10'}`}
                  >
                    {referralEnabled ? 'TURN OFF' : 'TURN ON'}
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Enter your invite code (e.g. abc123)"
                    className="input-field flex-1 font-mono text-[11px] py-2"
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      socket.emit('save-settings', { ...{ mainWalletAddress, proxyMode, proxyHost, proxyPort, proxyUser, proxyPass, referralCode, referralEnabled, fleetPaused, turnstileSolverUrl, useFakeIp } });
                    }}
                    className="px-4 py-2 rounded-lg text-[10px] font-bold border bg-cyan-500/20 text-cyan-400 border-cyan-500/50 hover:bg-cyan-500/30 transition-all"
                  >
                    SAVE
                  </button>
                </div>
                <p className="text-[9px] text-text-dim/40 mt-3 italic leading-tight">
                  When enabled, every worker session is created with your referral code. You earn 100% of every click your workers make, plus a one-time bonus per new session.
                </p>
              </div>

              {/* REMOTE SOLVER CONFIG */}
              <div className="bg-black/30 p-4 rounded-xl border border-white/5">
                <div className="flex justify-between items-center mb-4">
                  <label className="text-xs font-bold text-text-dim uppercase tracking-wider flex items-center gap-2">
                    🖥️ Turnstile Solver URL
                  </label>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="http://IP_ADDRESS:3000"
                    className="input-field flex-1 font-mono text-[11px] py-2"
                    value={turnstileSolverUrl}
                    onChange={(e) => setTurnstileSolverUrl(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      socket.emit('save-settings', { ...{ mainWalletAddress, proxyMode, proxyHost, proxyPort, proxyUser, proxyPass, referralCode, referralEnabled, fleetPaused, turnstileSolverUrl, useFakeIp } });
                    }}
                    className="px-4 py-2 rounded-lg text-[10px] font-bold border bg-purple-500/20 text-purple-400 border-purple-500/50 hover:bg-purple-500/30 transition-all"
                  >
                    SAVE
                  </button>
                </div>
                <p className="text-[9px] text-text-dim/40 mt-3 italic leading-tight">
                  Point this to your dedicated 32GB VM IP if running a split architecture. Default is <code>http://localhost:3000</code>.
                </p>
              </div>

              <div className="bg-black/30 p-4 rounded-xl border border-white/5">
                <div className="flex justify-between items-center mb-4">
                  <label className="text-xs font-bold text-text-dim tracking-wider uppercase">Auto-Withdraw</label>
                  <button
                    onClick={() => setAutoWithdraw(!autoWithdraw)}
                    className={`px-4 py-1.5 rounded-lg text-xs font-black tracking-widest uppercase transition-all flex items-center ${autoWithdraw ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 glow-cyan' : 'bg-white/5 text-text-dim border border-white/10 hover:bg-white/10'}`}
                  >
                    {autoWithdraw ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className={`transition-all ${autoWithdraw ? 'opacity-100' : 'opacity-20 pointer-events-none'}`}>
                  <label className="text-[10px] text-text-dim mb-1 block">Threshold (Nano-units)</label>
                  <input
                    type="number"
                    className="input-field w-full font-mono text-sm"
                    value={withdrawLimit}
                    onChange={(e) => setWithdrawLimit(e.target.value)}
                    placeholder="600"
                  />
                </div>
              </div>

              <div className="pt-4">
                {isRunning ? (
                  <>
                    <div className="flex gap-2">
                      <button
                        onClick={stopFleet}
                        className="flex-1 py-4 rounded-xl font-black tracking-widest uppercase bg-red-500/20 text-red-500 border border-red-500/50 hover:bg-red-500/30 transition-all flex items-center justify-center glow-red"
                      >
                        <Square className="mr-2 size-5" /> Halt Fleet
                      </button>
                      {fleetPaused ? (
                        <button
                          onClick={resumeFleet}
                          className="flex-1 py-4 rounded-xl font-black tracking-widest uppercase bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30 transition-all flex items-center justify-center glow-green shadow-[0_0_15px_rgba(34,197,94,0.1)]"
                        >
                          <Play className="mr-2 size-5" /> Resume
                        </button>
                      ) : (
                        <button
                          onClick={pauseFleet}
                          className="flex-1 py-4 rounded-xl font-black tracking-widest uppercase bg-yellow-500/20 text-yellow-500 border border-yellow-500/50 hover:bg-yellow-500/30 transition-all flex items-center justify-center glow-yellow shadow-[0_0_15px_rgba(234,179,8,0.1)]"
                        >
                          <Square className="mr-2 size-5" /> Pause
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => socket.emit('sweep-active')}
                      className="w-full mt-4 py-4 rounded-xl font-black tracking-widest uppercase bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30 transition-all flex items-center justify-center glow-green"
                    >
                      <Wallet className="mr-2 size-5" /> Emergency Global Sweep
                    </button>
                  </>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={startFleet}
                      className="flex-1 py-3 px-4 rounded-lg text-[10px] font-black tracking-widest uppercase bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 hover:bg-cyan-500/30 transition-all flex items-center justify-center glow-cyan"
                    >
                      <Power className="mr-2 size-5" /> Initialize Fleet
                    </button>

                    {Object.keys(runners).length > 0 && fleetPaused && (
                      <button
                        onClick={resumeFleet}
                        className="flex-1 py-3 px-4 rounded-lg text-[10px] font-black tracking-widest uppercase bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30 transition-all flex items-center justify-center glow-green"
                      >
                        <Play className="mr-2 size-5" /> Resume Fleet
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* LIVE EARNINGS & LOGS */}
            <section className="glass-panel lg:col-span-2 flex flex-col h-full">
              <h2 className="text-xl font-black flex items-center border-b border-white/10 pb-4 mb-4">
                <Activity className="mr-3 size-5" color="#00ff88" /> LIVE TELEMETRY
              </h2>

              <div className="flex-1 min-h-[250px] mb-6 overflow-y-auto bg-black/40 rounded-xl border border-white/5">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-text-dim pb-2">
                      <th className="p-3 font-bold">Worker Unit</th>
                      <th className="p-3 font-bold">Status</th>
                      <th className="p-3 font-bold">Session Wallet</th>
                      <th className="p-3 font-bold text-right pt-1 pb-1">Yield (NANO)</th>
                      <th className="p-3 font-bold text-right pl-6">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs font-mono">
                    {accounts.map(acc => {
                      const runner = runners[acc.name];
                      const status = runner?.status || 'idle';
                      const proxyWallet = runner?.proxyWallet;
                      return (
                        <tr key={acc.name} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                          <td className="p-3 flex items-center">
                            <div className={`w-2 h-2 rounded-full mr-2 ${status === 'running' ? 'bg-green-500 shadow-[0_0_10px_#00ff88]' : 'bg-gray-600'}`} />
                            {acc.name}
                          </td>
                          <td className="p-3">
                            <span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider ${status === 'running' ? 'bg-cyan-500/20 text-cyan-400' :
                              status === 'consolidating' ? 'bg-yellow-500/20 text-yellow-400 animate-pulse' :
                                status === 'bridged' ? 'bg-green-500/20 text-green-400 border border-green-500/50' :
                                  status === 'bridge-error' ? 'bg-red-500/20 text-red-400 border border-red-500/50' :
                                    'bg-white/5 text-text-dim'
                              }`}>
                              {status}
                            </span>
                          </td>
                          <td className="p-3 text-cyan-400/80 text-[10px] truncate max-w-[140px]" title={proxyWallet}>
                            {proxyWallet || (status === 'running' ? 'Initializing...' : '---')}
                          </td>
                          <td className="p-3 text-right text-white font-bold">
                            {formatNano(acc.earnings)}
                          </td>
                          <td className="p-3 text-right">
                            <div className="flex justify-end gap-2">
                              {status === 'running' && (
                                <button
                                  onClick={() => socket.emit('stop-runner', acc.name)}
                                  className="p-1.5 bg-red-500/10 hover:bg-red-500/30 border border-red-500/30 rounded text-red-400 transition-colors"
                                  title="Stop Worker"
                                >
                                  <Square className="size-3" />
                                </button>
                              )}
                              <button
                                onClick={() => socket.emit('sweep-worker', { accountName: acc.name, mainAddress: mainWalletAddress })}
                                className="p-1.5 bg-green-500/10 hover:bg-green-500/30 border border-green-500/30 rounded text-green-400 transition-colors"
                                title="Sweep Balance"
                              >
                                <Wallet className="size-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {accounts.length === 0 && (
                      <tr>
                        <td colSpan="5" className="text-center p-8 text-text-dim italic">Fleet uninitialized. Configure and Start to spawn workers.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-between items-center mb-2 mt-4">
                <h3 className="text-xs font-bold text-text-dim flex items-center uppercase tracking-widest">
                  <Terminal className="size-3 mr-2" /> Mission Logs
                </h3>
                <button
                  onClick={() => setShowLogs(!showLogs)}
                  className={`text-[10px] px-3 py-1 rounded-md font-black uppercase tracking-widest transition-colors ${showLogs ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-text-dim hover:bg-white/10'}`}
                >
                  {showLogs ? 'Hide Logs' : 'Show Logs'}
                </button>
              </div>

              {showLogs && (
                <div className="h-40 bg-black/60 rounded-xl p-3 overflow-y-auto font-mono text-[10px] border border-white/5">
                  {logs.map(log => (
                    <div key={log.id} className="mb-1 text-gray-400">
                      <span className="text-cyan-500 font-bold">[{log.name}]</span> {log.msg}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </motion.div>
        ) : activeTab === 'wallet' ? (
          <motion.div
            key="wallet"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="grid grid-cols-1 lg:grid-cols-2 gap-8"
          >
            <section className="glass-panel">
              <h2 className="text-2xl font-black flex items-center border-b border-white/10 pb-4 mb-6">
                <Wallet className="mr-3 size-6" color="#00f2ff" /> MASTER WALLET HUB
              </h2>

              <div className="space-y-6">
                <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-6 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none" />
                  <label className="text-xs font-bold text-cyan-400 mb-2 block uppercase tracking-wider flex items-center">
                    <Shield className="mr-2 size-3" /> Master Destination Address
                  </label>
                  <input
                    type="text"
                    className="input-field w-full text-sm font-mono tracking-wider bg-black/50"
                    value={mainWalletAddress}
                    onChange={(e) => setMainWalletAddress(e.target.value)}
                  />
                  <p className="text-[10px] text-text-dim mt-2">All autonomous withdrawals and manual sweeps will be routed to this secure Nano address.</p>
                </div>

                <div className="bg-white/5 border border-white/10 rounded-xl p-6">
                  <h3 className="text-sm font-bold text-white mb-4 flex items-center">
                    <Layers className="mr-2 size-4 text-green-400" /> Manual Consolidator
                  </h3>
                  <p className="text-xs text-text-dim mb-4 leading-relaxed">
                    Trigger an immediate sweep of all active fleet worker balances into your Master Destination Address. This overrides auto-withdraw limits.
                  </p>
                  <button
                    onClick={sweepAll}
                    className="w-full py-3 rounded-lg font-black tracking-widest uppercase bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30 transition-all flex items-center justify-center glow-green"
                  >
                    <RefreshCcw className="mr-2 size-4" /> Sweep All Active Balances
                  </button>
                </div>
              </div>
            </section>

            <section className="glass-panel">
              <h2 className="text-2xl font-black flex items-center border-b border-white/10 pb-4 mb-6">
                <Server className="mr-3 size-6" color="#00ff88" /> NODE SENTINEL
              </h2>
              <p className="text-xs text-text-dim mb-6">
                Continuous health and latency monitoring of public Nano RPC endpoints. Ensures sweeps and transactions have guaranteed delivery routes.
              </p>
              <div className="space-y-3">
                {Object.entries(nodeHealth).map(([url, data]) => (
                  <div key={url} className="flex justify-between items-center p-4 bg-black/40 rounded-xl border border-white/5 hover:border-white/10 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`status-indicator ${data.status === 'healthy' ? 'healthy' : 'error'}`} />
                      <div>
                        <div className="text-xs font-bold tracking-wider">{url.replace('https://', '').split('/')[0]}</div>
                        <div className="text-[9px] text-text-dim truncate max-w-[150px]">{url}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      {data.status === 'healthy' ? (
                        <div className="text-xs font-mono text-green-400 flex items-center gap-1 justify-end">
                          {data.latency}ms <CheckCircle2 className="size-3" />
                        </div>
                      ) : (
                        <div className="text-[10px] font-bold text-red-400 uppercase tracking-widest">
                          Connection Failed
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </motion.div>
        ) : activeTab === 'rescue' ? (
          <motion.div
            key="rescue"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="max-w-4xl mx-auto"
          >
            <section className="glass-panel">
              <h2 className="text-2xl font-black flex items-center border-b border-white/10 pb-4 mb-6">
                <AlertTriangle className="mr-3 size-6" color="#ff4444" /> RESCUE VAULT
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-6 text-center">
                  <div className="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-2">Rescued Wallets</div>
                  <div className="text-4xl font-black text-red-400 font-mono">{rescuedWallets.length}</div>
                </div>
                <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-6 text-center">
                  <div className="text-[10px] font-bold text-orange-400 uppercase tracking-wider mb-2">Total Rescued Balance</div>
                  <div className="text-4xl font-black text-orange-400 font-mono">{formatNano(rescuedTotal)} <span className="text-lg">NANO</span></div>
                </div>
              </div>

              <p className="text-xs text-text-dim mb-4 leading-relaxed">
                These wallets received funds from the faucet but failed to consolidate to the master wallet. Their seeds are preserved here so you can recover the funds manually.
              </p>

              <div className="flex flex-wrap gap-3 mb-6">
                <button
                  onClick={() => socket.emit('rescue-stale-sessions')}
                  className="flex-1 min-w-[200px] py-3 rounded-lg font-black tracking-widest uppercase transition-all flex items-center justify-center border bg-orange-500/20 text-orange-400 border-orange-500/50 hover:bg-orange-500/30 glow-orange cursor-pointer"
                >
                  <RefreshCcw className="mr-2 size-4" /> Rescue All Stale Balances
                </button>
                <a
                  href="/api/rescued-wallets/download"
                  className={`flex-1 min-w-[200px] py-3 rounded-lg font-black tracking-widest uppercase transition-all flex items-center justify-center border ${rescuedWallets.length > 0
                    ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50 hover:bg-cyan-500/30 glow-cyan cursor-pointer'
                    : 'bg-white/5 text-text-dim/30 border-white/5 cursor-not-allowed'
                    }`}
                >
                  <Download className="mr-2 size-4" /> Download All Seeds
                </a>
                <button
                  onClick={async () => {
                    if (rescuedWallets.length === 0) return;
                    if (!window.confirm('Clear rescue vault? Make sure you downloaded the seeds first!')) return;
                    await fetch('/api/rescued-wallets', { method: 'DELETE' });
                  }}
                  className={`px-6 py-3 rounded-lg font-black tracking-widest uppercase transition-all flex items-center justify-center border ${rescuedWallets.length > 0
                    ? 'bg-red-500/20 text-red-400 border-red-500/50 hover:bg-red-500/30'
                    : 'bg-white/5 text-text-dim/30 border-white/5 cursor-not-allowed'
                    }`}
                >
                  Clear
                </button>
              </div>

              {rescuedWallets.length > 0 ? (
                <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
                  {rescuedWallets.map((w, i) => (
                    <div key={i} className={`bg-black/40 rounded-xl border p-4 transition-colors ${w.withdrawn ? 'border-green-500/30 bg-green-500/5' : 'border-white/5 hover:border-red-500/20'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-black text-red-400">#{i + 1} &mdash; {w.name} {w.withdrawn && <span className="text-green-400 ml-2">✓ WITHDRAWN</span>}</span>
                        <span className="text-[10px] font-mono text-orange-400 font-bold">{w.balance} NANO</span>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[9px] text-text-dim/60">ADDRESS</div>
                        <div className="text-[10px] font-mono text-text-dim break-all">{w.address}</div>
                        <div className="text-[9px] text-text-dim/60 mt-2">TOKEN STATE</div>
                        <div className="text-[10px] font-mono text-cyan-400/80 break-all">{w.token ? 'SESSION PRESERVED' : 'STALE (RETRY IMPOSSIBLE)'}</div>
                        <div className="text-[8px] text-text-dim/40 mt-1">Rescued: {new Date(w.rescuedAt).toLocaleString()}</div>
                      </div>
                      {!w.withdrawn && w.token && (
                        <div className="mt-4 flex gap-2">
                          <button
                            onClick={() => socket.emit('rescue-retry-withdrawal', w.seed)}
                            disabled={w.rescueStatus === 'retrying...'}
                            className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all ${w.rescueStatus === 'retrying...' ? 'bg-white/5 text-text-dim border-white/10 animate-pulse' : 'bg-orange-500/10 text-orange-400 border-orange-500/30 hover:bg-orange-500/30'}`}
                          >
                            {w.rescueStatus === 'retrying...' ? 'WITHDRAWING...' : 'RETRY WITHDRAWAL'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-16">
                  <CheckCircle2 className="size-16 text-green-500/30 mx-auto mb-4" />
                  <p className="text-sm text-text-dim/60">No rescued wallets. All consolidations successful!</p>
                </div>
              )}
            </section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function StatCard({ icon, label, value }) {
  return (
    <motion.div whileHover={{ y: -5 }} className="glass-panel stat-card">
      <div className="flex items-center mb-3">
        <div className="p-3 bg-white/5 rounded-xl mr-3">{icon}</div>
        <div className="stat-label uppercase text-[10px] font-black tracking-tighter">{label}</div>
      </div>
      <div className="text-2xl font-black text-white tracking-widest font-mono">{value}</div>
    </motion.div>
  );
}

export default App;
