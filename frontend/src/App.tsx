/*
Bucaro React Frontend (Phase 3)
Single-file React app (App.tsx) built to work with the provided Socket.IO server.

- Built with Vite + React + TypeScript + TailwindCSS.
- Uses socket.io-client to communicate with the server endpoints created in Phase 2.
- Simplified UX: click-to-select cards for meld creation, click actions for draw/discard/show.
- Not a full production UI (no rich drag-drop), but complete and functional for gameplay and testing.

How to use
----------
1. Create a Vite React + TS project:
   npm create vite@latest bucario-ui -- --template react-ts
   cd bucario-ui
2. Install dependencies:
   npm i socket.io-client
   npm install -D tailwindcss postcss autoprefixer
   npx tailwindcss init -p
   // configure tailwind per docs; add @tailwind directives to index.css
3. Replace src/App.tsx with the file below. Run `npm run dev`.
4. Ensure the Socket.IO server (Phase 2) is running on PORT 8080 (or change SERVER_URL).

Notes
-----
- This file is intentionally single-file to make it easy to drop into src/App.tsx.
- It assumes Tailwind is configured; classes are used for layout.

*/

import { useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:8080';

type Card = { suit: string; rank: number; id: string };

type PlayerView = any;

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('Player');
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [seat, setSeat] = useState<number | null>(null);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [lobby, setLobby] = useState<any>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);

  useEffect(() => {
    const s = io(SERVER_URL, { autoConnect: false });
    setSocket(s);
    s.on('connect', () => { setConnected(true); console.log('socket connected'); });
    s.on('disconnect', () => { setConnected(false); });

    s.on('joined', (info:any) => {
      setPlayerId(info.playerId);
      setSeat(info.seat);
      setTeamId(info.teamId);
    });

    s.on('lobby', (data:any) => { setLobby(data); });
    s.on('state', (st:any) => {
      // server sends per-player PlayerView or results
      setView(st);
    });
    s.on('errorMsg', (msg:string) => alert('Server: '+msg));
    s.on('toast', (msg:string) => console.log('toast', msg));

    return () => { s.close(); };
  }, []);

  const connectAndJoin = (room:string) => {
    if (!socket) return;
    socket.connect();
    socket.emit('joinRoom', { roomId: room, name, playerId: playerId ?? undefined });
    setRoomId(room);
  };

  const createRoom = async () => {
    const res = await fetch(SERVER_URL + '/rooms', { method: 'POST' });
    const j = await res.json();
    connectAndJoin(j.roomId);
  };

  const joinRoom = () => connectAndJoin(roomId);

  const startGame = () => socket?.emit('startGame');
  const drawClosed = () => socket?.emit('drawClosed');
  const drawOpen = () => socket?.emit('drawOpen');

  const toggleSelectCard = (id:string) => {
    setSelectedCardIds(s => s.includes(id) ? s.filter(x=>x!==id) : [...s, id]);
  };

  const placeMelds = () => {
    if (!selectedCardIds.length) return alert('select card ids for a single meld (simplified)');
    const melds = [{ cardIds: selectedCardIds }];
    socket?.emit('placeMelds', { melds });
    setSelectedCardIds([]);
  };

  const discard = () => {
    if (selectedCardIds.length !== 1) return alert('Select exactly 1 card to discard');
    socket?.emit('discard', { cardId: selectedCardIds[0] });
    setSelectedCardIds([]);
  };

  const doShow = () => {
    // Expect user to select multiple meld payloads by grouping; simplified: send one meld composed of selected
    if (selectedCardIds.length < 7) return alert('Select the cards you are placing in show (must include a 7-card pure)');
    const payload = { melds: [{ cardIds: selectedCardIds }] };
    socket?.emit('show', payload);
    setSelectedCardIds([]);
  };

  const seatName = useMemo(() => {
    if (!lobby) return 'No room';
    const s = lobby.seats.map((x:any)=> x.name ?? 'empty').join(' | ');
    return s;
  }, [lobby]);

  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Bucaro — Online (UI Prototype)</h1>
          <div className="text-sm text-slate-600">Server: {SERVER_URL} • Socket: {connected ? 'connected' : 'disconnected'}</div>
        </header>

        {!playerId ? (
          <div className="grid grid-cols-2 gap-6">
            <div className="p-4 bg-white rounded shadow">
              <h2 className="font-semibold mb-2">Create / Join Room</h2>
              <label className="block text-xs text-slate-500">Your name</label>
              <input className="w-full border p-2 rounded mb-2" value={name} onChange={e=>setName(e.target.value)} />

              <div className="flex gap-2">
                <button className="btn" onClick={createRoom}>Create room</button>
                <input className="border p-2 rounded" placeholder="ROOM ID" value={roomId} onChange={e=>setRoomId(e.target.value)} />
                <button className="btn" onClick={joinRoom}>Join</button>
              </div>

              <div className="mt-4 text-sm text-slate-600">Seats: {seatName}</div>
            </div>

            <div className="p-4 bg-white rounded shadow">
              <h2 className="font-semibold mb-2">How to play (quick)</h2>
              <ol className="list-decimal pl-4 text-sm text-slate-700">
                <li>Create/join a room (4 players).</li>
                <li>Start game when all joined.</li>
                <li>On your turn, draw (closed/open), place melds by selecting cards and clicking "Place Melds", then discard 1 selected card.</li>
                <li>Use "Show" to show a 7-card pure (select the cards and click Show).</li>
              </ol>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 p-4 bg-white rounded shadow">
              <div className="flex items-center justify-between mb-3">
                <div>Room <strong>{roomId}</strong></div>
                <div>Seat: {seat} • Team: {teamId}</div>
              </div>

              <div className="flex gap-4">
                <div className="w-2/3">
                  <TableView view={view} selectedCardIds={selectedCardIds} onCardClick={toggleSelectCard} />
                </div>

                <div className="w-1/3">
                  <div className="p-3 bg-slate-50 rounded">
                    <div className="mb-2">Actions</div>
                    <div className="flex flex-col gap-2">
                      <button className="btn" onClick={startGame}>Start Game</button>
                      <button className="btn" onClick={drawClosed}>Draw Closed</button>
                      <button className="btn" onClick={drawOpen}>Draw Open</button>
                      <button className="btn" onClick={placeMelds}>Place Melds (selected)</button>
                      <button className="btn" onClick={discard}>Discard (select 1)</button>
                      <button className="btn" onClick={doShow}>Show (selected)</button>
                      <button className="btn" onClick={() => socket?.emit('getState')}>Refresh</button>
                    </div>

                    <div className="mt-4 text-sm">
                      <div>Open Top: {view?.openTop ? cardLabel(view.openTop) : '—'}</div>
                      <div>Open Count: {view?.openCount ?? 0}</div>
                      <div>Closed Count: {view?.closedCount ?? 0}</div>
                      <div>Current Turn: {view?.currentTurn}</div>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-white rounded shadow text-sm">
                    <h3 className="font-semibold">Selected ({selectedCardIds.length})</h3>
                    <ul>
                      {selectedCardIds.map(id=> <li key={id} className="text-xs">{id}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-white rounded shadow">
              <h3 className="font-semibold mb-2">Your Hand</h3>
              <div className="flex flex-wrap gap-2">
                {(view?.yourHand ?? []).map((c:Card)=> (
                  <CardView key={c.id} card={c} selected={selectedCardIds.includes(c.id)} onClick={()=>toggleSelectCard(c.id)} />
                ))}
              </div>

              <div className="mt-4">
                <h4 className="font-semibold">Team Boards</h4>
                <pre className="text-xs bg-slate-50 p-2 rounded mt-2">{JSON.stringify(view?.teamBoards, null, 2)}</pre>
              </div>
            </div>
          </div>
        )}

        <footer className="mt-6 text-xs text-slate-500">Prototype UI • Tailwind + Socket.IO client</footer>
      </div>
    </div>
  );
}

function TableView({ view, selectedCardIds, onCardClick } : { view: PlayerView | null; selectedCardIds: string[]; onCardClick: (id:string)=>void }) {
  if (!view) return <div className="p-6">No state yet</div>;
  return (
    <div className="bg-white rounded p-3 shadow">
      <div className="mb-2 text-sm">Table</div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <div className="mb-2">Open Pile Top: {view.openTop ? cardLabel(view.openTop) : '—'}</div>
          <div className="flex gap-2 flex-wrap">
            {(view.yourHand ?? []).slice(0,6).map((c:Card)=> (
              <MiniCard key={c.id} card={c} selected={selectedCardIds.includes(c.id)} onClick={()=>onCardClick(c.id)} />
            ))}
          </div>
        </div>
        <div>
          <div>Partner: {view.partner?.name} ({view.partner?.cardCount})</div>
          <div>Opponents:</div>
          <div>{view.opponents?.map((o:any)=> <div key={o.id}>{o.name} ({o.cardCount})</div>)}</div>
        </div>
      </div>
    </div>
  );
}

function cardLabel(c:Card) {
  if (!c) return '—';
  const ranks:any = {1:'A',11:'J',12:'Q',13:'K'};
  const r = ranks[c.rank] ?? c.rank;
  return `${r}${c.suit}`;
}

function CardView({ card, selected, onClick }: { card:Card; selected:boolean; onClick:()=>void }) {
  return (
    <div onClick={onClick} className={`cursor-pointer p-2 rounded border ${selected ? 'bg-blue-100 border-blue-400' : 'bg-white border-slate-200'}`}>
      <div className="text-sm font-medium">{cardLabel(card)}</div>
      <div className="text-xs text-slate-500">{card.id.slice(-6)}</div>
    </div>
  );
}

function MiniCard({ card, selected, onClick }:{ card:Card; selected:boolean; onClick:()=>void }) {
  return (
    <button onClick={onClick} className={`px-2 py-1 rounded text-xs border ${selected? 'bg-blue-100 border-blue-400' : 'bg-white border-slate-200'}`}>
      {cardLabel(card)}
    </button>
  );
}
