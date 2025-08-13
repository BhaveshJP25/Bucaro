/* 
Bucaro Game Engine – Phase 1 (Core Rules & Scoring)
Author: ChatGPT for Bhavesh Parakh

Overview
--------
This TypeScript module implements the full core logic for the 4-player, 2-team
Bucaro card game as specified by Bhavesh. It covers:
- Game setup (2 decks; 2s are jokers; printed jokers included)
- Deal: 4 hands of 13 + 1 extra stack of 13 (reserved for first Show)
- Turn flow: draw (closed or open with restrictions) → optional place → discard
- Team pure-sequence requirement
- Show logic (7-card pure sequence or 7 of a kind; impure 7 is invalid)
- Max 1 joker per meld (except the special "3 jokers together" set)
- Joker pick restrictions; no discarding a joker onto a joker on open pile
- End conditions: closed pile exhausted OR two Shows total (can be same team)
- Scoring

Assumptions (explicit)
----------------------
1) Card value for Jokers during point tally is treated as 0. (Not specified by
   rules; we choose 0; adjust in JOKER_CARD_VALUE if different.)
2) "A joker cannot be placed on top of a joker" is interpreted as: you cannot
   discard a joker if the top of the open pile is also a joker.
3) Placing cards when a team has no pure sequence: allowed only if the *result*
   of the placement gives the team at least one pure sequence.
4) You may add to existing melds while keeping the "max 1 joker per meld" rule.
5) The special "3 jokers together" counts as a valid set for placement, but is
   NOT a 7-card qualifying Show (obviously) and scores as an impure set (100),
   since it uses jokers and is not a natural set/sequence of rank/suit.
6) Aces are high for sequencing (A-2-3 is not pure), and sequences do not wrap.

Exported API (high-level)
-------------------------
- class BucaroGame
  - constructor(config?: Partial<GameConfig>)
  - addPlayer(id: string, name: string): void
  - startGame(): void
  - getPublicState(): PublicState
  - getPlayerState(playerId: string): PlayerView
  - drawFromClosed(playerId: string): void
  - drawFromOpen(playerId: string): void
  - placeMelds(playerId: string, melds: MeldPayload[]): void
  - addCardsToMeld(playerId: string, additions: MeldAdditionPayload[]): void
  - discard(playerId: string, card: Card): void
  - show(playerId: string, payload: ShowPayload): void
  - computeFinalScores(): FinalScoreSummary

Notes
-----
- Phase 1 is engine-only (no sockets/UI).
- Designed to drop into a Node/Express + Socket.IO server. All rules are pure
  functions where possible; mutating ops throw on invalid actions.
*/

//#region Types

type Suit = 'S' | 'H' | 'D' | 'C' | 'JOKER';

export interface Card {
  suit: Suit;        // 'S','H','D','C' or 'JOKER'
  rank: number;      // 1..13 for A..K when suit!=JOKER; 0 for printed joker; 2s are jokers via isJoker(card)
  id: string;        // unique id per physical card instance
}

export enum MeldType {
  SequencePure = 'SequencePure',
  SequenceImpure = 'SequenceImpure',
  SetPure = 'SetPure',
  SetImpure = 'SetImpure',
  ThreeJokers = 'ThreeJokers',
}

export interface Meld {
  id: string;
  type: MeldType;
  cards: Card[];        // ordered for sequences; any order for sets
}

export interface TeamBoard {
  teamId: number; // 0 or 1
  melds: Meld[];
}

export interface Player {
  id: string;
  name: string;
  teamId: number; // 0 or 1
  hand: Card[];
}

export interface GameConfig {
  rngSeed?: string;
}

export interface PublicState {
  status: 'LOBBY' | 'ACTIVE' | 'ENDED';
  currentTurn: number;      // index 0..3
  dealerIndex: number;      // index 0..3
  openTop: Card | null;
  openCount: number;
  closedCount: number;
  showsDone: number;        // total number of shows across teams
  teamPurePresent: [boolean, boolean];
}

export interface PlayerView extends PublicState {
  you: Player;
  partner: { id: string; name: string; cardCount: number };
  opponents: Array<{ id: string; name: string; cardCount: number }>;
  yourHand: Card[];
  teamBoards: [TeamBoard, TeamBoard];
}

export interface MeldPayload {
  // A proposed meld using card IDs from the player's hand (and possibly the drawn card this turn).
  cardIds: string[];
}

export interface MeldAdditionPayload {
  meldId: string;
  cardIds: string[]; // cards from hand to add onto an existing team meld
}

export interface ShowPayload {
  // All cards the player will place down during show (must leave exactly one in hand for discard later in show())
  melds: MeldPayload[];
}

export interface FinalScoreSummary {
  teamScores: [number, number];
  details: {
    teamId: number;
    meldPoints: number;   // 200 / 100 per meld as per type
    cardPoints: number;   // 3-7=5; 8-10,J,Q,K=10; A=15; Jokers=JOKER_CARD_VALUE
    penalty: number;      // -200 if no 7-card pure sequence/set
    inHandGainsFromOpp: number; // points gained from opposing hands transfer
    comment: string;
  }[];
}

//#endregion

//#region Utilities / Constants

const JOKER_CARD_VALUE = 0; // assumption per notes

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function cardLabel(c: Card): string {
  if (c.suit === 'JOKER') return '🃏Joker';
  const ranks = {1:'A',11:'J',12:'Q',13:'K'} as Record<number,string>;
  const r = ranks[c.rank] ?? String(c.rank);
  return `${r}${c.suit}`;
}

function isPrintedJoker(c: Card): boolean { return c.suit === 'JOKER'; }
function isTwo(c: Card): boolean { return c.suit !== 'JOKER' && c.rank === 2; }
function isJoker(c: Card): boolean { return isPrintedJoker(c) || isTwo(c); }

function compareCards(a: Card, b: Card): number {
  // For sorting by suit then rank then id
  if (a.suit !== b.suit) return a.suit < b.suit ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.id < b.id ? -1 : 1;
}

//#endregion

//#region Deck / Setup

function buildTwoDecks(): Card[] {
  const cards: Card[] = [];
  const suits: Suit[] = ['S','H','D','C'];
  for (let deck = 0; deck < 2; deck++) {
    // Standard suits A..K (1..13)
    for (const s of suits) {
      for (let r = 1; r <= 13; r++) {
        const c: Card = { suit: s, rank: r, id: uid('c') };
        cards.push(c);
      }
    }
    // Printed joker (assume 2 printed jokers per deck -> adjust if needed)
    for (let pj = 0; pj < 2; pj++) {
      cards.push({ suit: 'JOKER', rank: 0, id: uid('j') });
    }
  }
  return shuffle(cards);
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

//#endregion

//#region Meld Validation

function classifyMeld(cards: Card[]): MeldType | null {
  // Special: exactly 3 jokers
  if (cards.length === 3 && cards.every(isJoker)) return MeldType.ThreeJokers;

  // Count jokers
  const jokers = cards.filter(isJoker);
  if (jokers.length > 1) return null; // max 1 joker per meld (except 3 jokers special)

  const naturals = cards.filter(c => !isJoker(c));
  if (naturals.length < 2) return null; // need at least 2 naturals to form ≥3 total with 1 joker

  // Try Set (same rank, different suits allow duplicates across double-deck)
  const ranks = new Set(naturals.map(c => c.rank));
  const suits = new Set(naturals.map(c => c.suit));
  if (ranks.size === 1) {
    return jokers.length === 0 ? MeldType.SetPure : MeldType.SetImpure;
  }

  // Try Sequence (same suit, consecutive ranks; A high only; no wrap)
  if (suits.size === 1) {
    const suit = naturals[0].suit;
    if (suit === 'JOKER') return null; // shouldn't happen since filtered
    const sorted = naturals.slice().sort((a,b)=>a.rank-b.rank);
    // No duplicates of same rank within sequence (even double-deck) among naturals
    for (let i=1;i<sorted.length;i++) if (sorted[i].rank===sorted[i-1].rank) return null;
    // Check gaps
    let gaps = 0;
    for (let i=1;i<sorted.length;i++) {
      const diff = sorted[i].rank - sorted[i-1].rank;
      if (diff < 1) return null;
      gaps += (diff - 1);
    }
    // Jokers can fill gaps or extend at ends by exactly 1 card position
    if (gaps > 1) return null; // with 1 joker we can fill at most 1 gap or extend by one
    return jokers.length === 0 ? MeldType.SequencePure : MeldType.SequenceImpure;
  }

  return null;
}

function isPureSevenForShow(cards: Card[]): boolean {
  const t = classifyMeld(cards);
  if (t === MeldType.SequencePure && cards.length >= 7) return true;
  if (t === MeldType.SetPure && cards.length >= 7) return true;
  return false; // impure not allowed for 7-card show
}

function isPureSequence(cards: Card[]): boolean { return classifyMeld(cards) === MeldType.SequencePure; }

//#endregion

//#region Game Class

export class BucaroGame {
  private config: GameConfig;
  private players: Player[] = [];
  private teamBoards: [TeamBoard, TeamBoard] = [ {teamId:0, melds:[]}, {teamId:1, melds:[]} ];
  private dealerIndex = 0;
  private currentTurn = 0;
  private deck: Card[] = [];
  private closed: Card[] = [];
  private open: Card[] = [];
  private extraShowStack: Card[] = []; // 5th 13-card stack
  private status: 'LOBBY' | 'ACTIVE' | 'ENDED' = 'LOBBY';
  private showsDone = 0;
  private drewThisTurn = false;
  private placedThisTurn = false;

  constructor(config?: Partial<GameConfig>) {
    this.config = { ...config } as GameConfig;
  }

  addPlayer(id: string, name: string) {
    if (this.status !== 'LOBBY') throw new Error('Cannot join after game start');
    if (this.players.length >= 4) throw new Error('Lobby full');
    const teamId = this.players.length % 2; // 0,1,0,1 seating by join order
    this.players.push({ id, name, teamId, hand: [] });
  }

  startGame() {
    if (this.players.length !== 4) throw new Error('Need 4 players');
    if (this.status !== 'LOBBY') throw new Error('Game already started');

    this.deck = buildTwoDecks();

    // Deal 5 stacks of 13
    const stacks: Card[][] = [];
    for (let i=0;i<5;i++) stacks.push(this.deck.splice(0,13));

    // Assign 4 stacks to players in dealer order rotation rules
    // Dealer rotates every game; here we keep dealerIndex (0 default). The player to dealer's left starts.
    for (let p=0;p<4;p++) {
      const idx = (this.dealerIndex + p) % 4; // dealing order can be customized; for now simple assignment
      this.players[idx].hand = stacks[p].slice();
    }

    this.extraShowStack = stacks[4].slice();

    // Remaining cards -> closed; flip one to open
    this.closed = this.deck.slice();
    this.deck = [];

    if (this.closed.length === 0) throw new Error('Not enough cards after dealing');
    const firstOpen = this.closed.pop()!;
    this.open.push(firstOpen);

    this.currentTurn = (this.dealerIndex + 1) % 4; // left of dealer starts
    this.status = 'ACTIVE';
    this.showsDone = 0;
    this.drewThisTurn = false;
    this.placedThisTurn = false;
  }

  private get teamPurePresent(): [boolean, boolean] {
    return [
      this.teamBoards[0].melds.some(m=>m.type===MeldType.SequencePure),
      this.teamBoards[1].melds.some(m=>m.type===MeldType.SequencePure),
    ];
  }

  getPublicState(): PublicState {
    return {
      status: this.status,
      currentTurn: this.currentTurn,
      dealerIndex: this.dealerIndex,
      openTop: this.open[this.open.length-1] ?? null,
      openCount: this.open.length,
      closedCount: this.closed.length,
      showsDone: this.showsDone,
      teamPurePresent: this.teamPurePresent,
    };
  }

  getPlayerState(playerId: string): PlayerView {
    const idx = this.requirePlayerIndex(playerId);
    const you = this.players[idx];
    const partnerIdx = (idx + 2) % 4;
    const partner = this.players[partnerIdx];
    const opp1 = this.players[(idx+1)%4];
    const opp2 = this.players[(idx+3)%4];

    return {
      ...this.getPublicState(),
      you: clone(you),
      partner: { id: partner.id, name: partner.name, cardCount: partner.hand.length },
      opponents: [
        { id: opp1.id, name: opp1.name, cardCount: opp1.hand.length },
        { id: opp2.id, name: opp2.name, cardCount: opp2.hand.length },
      ],
      yourHand: clone(you.hand).sort(compareCards),
      teamBoards: clone(this.teamBoards),
    };
  }

  private requireTurn(playerId: string) {
    const idx = this.requirePlayerIndex(playerId);
    if (idx !== this.currentTurn) throw new Error('Not your turn');
    return idx;
  }

  private requirePlayerIndex(playerId: string): number {
    const idx = this.players.findIndex(p=>p.id===playerId);
    if (idx<0) throw new Error('Unknown player');
    return idx;
  }

  drawFromClosed(playerId: string) {
    const idx = this.requireTurn(playerId);
    if (this.drewThisTurn) throw new Error('Already drew this turn');
    if (this.closed.length === 0) throw new Error('Closed pile empty');
    const card = this.closed.pop()!;
    this.players[idx].hand.push(card);
    this.drewThisTurn = true;
  }

  drawFromOpen(playerId: string) {
    const idx = this.requireTurn(playerId);
    if (this.drewThisTurn) throw new Error('Already drew this turn');
    const top = this.open[this.open.length-1];
    if (!top) throw new Error('Open pile empty');

    // Enforce open draw condition: must immediately place the top card into a valid meld per rules
    // Also, if top is joker: only if used into pure sequence (rare) or 3 jokers together.

    // We'll perform a dry-run: does there exist a meld (using top + hand cards) that is valid and respects rules?
    const hand = this.players[idx].hand.slice();

    const canUseTop = this.canUseOpenTopImmediate(top, hand, this.players[idx].teamId);
    if (!canUseTop) throw new Error('Cannot pick from open: top card not immediately placeable per rules');

    // Take the top
    this.open.pop();
    this.players[idx].hand.push(top);
    this.drewThisTurn = true;
  }

  private canUseOpenTopImmediate(top: Card, hand: Card[], teamId: number): boolean {
    const pool = [top, ...hand];

    // try all combinations up to reasonable size (3..7+) that include top
    const combos = kCombinationsIncluding(pool, 3, 7, top); // try sizes 3..7 for immediate placement
    for (const combo of combos) {
      const t = classifyMeld(combo);
      if (!t) continue;
      if (t !== MeldType.ThreeJokers) {
        // If top is joker and meld is not pure sequence, reject unless it's ThreeJokers
        if (isJoker(top) && t !== MeldType.SequencePure) continue;
      } else {
        // ThreeJokers is allowed even if top is joker
      }
      // Enforce team pure requirement: if team currently lacks a pure sequence,
      // then this immediate placement must create one.
      const teamHasPure = this.teamBoards[teamId].melds.some(m=>m.type===MeldType.SequencePure);
      if (!teamHasPure && t !== MeldType.SequencePure) continue;

      return true;
    }
    return false;
  }

  placeMelds(playerId: string, melds: MeldPayload[]) {
    const idx = this.requireTurn(playerId);
    if (!this.drewThisTurn) throw new Error('Must draw before placing');

    const teamId = this.players[idx].teamId;
    const hand = this.players[idx].hand.slice();

    const realized: Meld[] = [];
    for (const mp of melds) {
      const cards = mp.cardIds.map(id=>
        hand.find(c=>c.id===id) || this.open.find(c=>c.id===id) || null
      );
      if (cards.some(c=>!c)) throw new Error('Card not in hand');
      const cset = cards as Card[];
      const t = classifyMeld(cset);
      if (!t) throw new Error('Invalid meld');
      realized.push({ id: uid('meld'), type: t, cards: cset.slice() });
    }

    // Team pure requirement: if team currently lacks pure sequence, at least one placed meld must be SequencePure
    const teamHasPure = this.teamBoards[teamId].melds.some(m=>m.type===MeldType.SequencePure);
    if (!teamHasPure) {
      if (!realized.some(m=>m.type===MeldType.SequencePure)) {
        throw new Error('Your team must establish a pure sequence with this placement');
      }
    }

    // All good: remove cards from hand and add melds to board
    for (const m of realized) {
      // remove from hand
      for (const c of m.cards) {
        const i = this.players[idx].hand.findIndex(x=>x.id===c.id);
        if (i<0) throw new Error('Internal: card missing from hand');
        this.players[idx].hand.splice(i,1);
      }
      this.teamBoards[teamId].melds.push(m);
    }

    this.placedThisTurn = true;
  }

  addCardsToMeld(playerId: string, additions: MeldAdditionPayload[]) {
    const idx = this.requireTurn(playerId);
    if (!this.drewThisTurn) throw new Error('Must draw before placing');

    const teamId = this.players[idx].teamId;

    for (const add of additions) {
      const meld = this.teamBoards[teamId].melds.find(m=>m.id===add.meldId);
      if (!meld) throw new Error('Target meld not on your team board');

      const addCards: Card[] = [];
      for (const id of add.cardIds) {
        const i = this.players[idx].hand.findIndex(c=>c.id===id);
        if (i<0) throw new Error('Card not in hand');
        addCards.push(this.players[idx].hand[i]);
      }

      // Validate merged meld
      const newMeldType = classifyMeld([...meld.cards, ...addCards]);
      if (!newMeldType) throw new Error('Addition would make meld invalid');

      meld.cards.push(...addCards);
      meld.type = newMeldType;

      // Remove from hand
      for (const c of addCards) {
        const i = this.players[idx].hand.findIndex(x=>x.id===c.id);
        this.players[idx].hand.splice(i,1);
      }
    }

    this.placedThisTurn = true;
  }

  discard(playerId: string, card: Card) {
    const idx = this.requireTurn(playerId);
    if (!this.drewThisTurn) throw new Error('Must draw before discarding');

    // Validate card in hand
    const i = this.players[idx].hand.findIndex(c=>c.id===card.id);
    if (i<0) throw new Error('Card not in hand');

    // No discarding joker on joker
    const top = this.open[this.open.length-1];
    if (top && isJoker(top) && isJoker(card)) {
      throw new Error('Cannot discard a joker on top of a joker');
    }

    // Discard
    this.players[idx].hand.splice(i,1);
    this.open.push(card);

    // End turn
    this.endTurnAdvance();
  }

  show(playerId: string, payload: ShowPayload) {
    const idx = this.requireTurn(playerId);
    if (!this.drewThisTurn) throw new Error('Must draw before show');

    // Build melds from payload using current hand
    const teamId = this.players[idx].teamId;
    const hand = this.players[idx].hand.slice();

    const realized: Meld[] = [];
    let usedCardIds = new Set<string>();

    for (const mp of payload.melds) {
      const cards: Card[] = [];
      for (const id of mp.cardIds) {
        if (usedCardIds.has(id)) throw new Error('Duplicate card in show payload');
        const found = hand.find(c=>c.id===id);
        if (!found) throw new Error('Card not in hand for show');
        cards.push(found);
        usedCardIds.add(id);
      }
      const t = classifyMeld(cards);
      if (!t) throw new Error('Invalid meld in show');
      realized.push({ id: uid('meld'), type: t, cards });
    }

    // Must contain at least one 7-card pure set/sequence
    const hasPureSeven = realized.some(m => (m.type===MeldType.SequencePure || m.type===MeldType.SetPure) && m.cards.length>=7);
    if (!hasPureSeven) throw new Error('Show requires a 7-card pure sequence or pure set');

    // Remove used cards from hand (must leave exactly one card in hand to discard in show())
    const remaining = hand.filter(c=>!usedCardIds.has(c.id));
    if (remaining.length !== 1) throw new Error('Show must leave exactly one card to discard');

    // Apply melds to board
    for (const m of realized) this.teamBoards[teamId].melds.push(m);

    // Update player hand
    this.players[idx].hand = remaining;

    // Discard the last card (required by rules)
    const lastToDiscard = this.players[idx].hand.pop()!;
    // Same joker-on-joker restriction
    const top = this.open[this.open.length-1];
    if (top && isJoker(top) && isJoker(lastToDiscard)) throw new Error('Cannot discard a joker on a joker (during show)');
    this.open.push(lastToDiscard);

    // Take the extra 13-card stack and continue turn
    if (this.extraShowStack.length !== 13) throw new Error('Extra show stack already taken');
    this.players[idx].hand.push(...this.extraShowStack);
    this.extraShowStack = [];

    // Mark show
    this.showsDone += 1;
    if (this.showsDone >= 2) {
      // Instant end of game
      this.status = 'ENDED';
      return;
    }

    // After show, player continues turn as normal (may place more, then discard to end)
    this.placedThisTurn = true; // since they placed a large set
  }

  private endTurnAdvance() {
    // If closed exhausted -> end game
    if (this.closed.length === 0) {
      this.status = 'ENDED';
    }

    this.currentTurn = (this.currentTurn + 1) % 4;
    this.drewThisTurn = false;
    this.placedThisTurn = false;
  }

  computeFinalScores(): FinalScoreSummary {
    if (this.status !== 'ENDED') throw new Error('Game not yet ended');

    // Compute meld points and card points from boards
    const details: FinalScoreSummary['details'] = [];

    // Helper to score a card value
    const cardValue = (c: Card): number => {
      if (isJoker(c)) return JOKER_CARD_VALUE;
      if (c.rank >= 3 && c.rank <= 7) return 5;
      if ((c.rank >= 8 && c.rank <= 10) || c.rank === 11 || c.rank === 12 || c.rank === 13) return 10;
      if (c.rank === 1) return 15; // Ace
      return 0; // rank 2 treated as joker, already handled above
    };

    const tallyTeam = (teamId: number) => {
      const board = this.teamBoards[teamId];
      let meldPoints = 0;
      let cardPoints = 0;
      let hasSevenPure = false;
      for (const m of board.melds) {
        switch (m.type) {
          case MeldType.SequencePure: meldPoints += 200; break;
          case MeldType.SetPure: meldPoints += 200; break;
          case MeldType.SequenceImpure: meldPoints += 100; break;
          case MeldType.SetImpure: meldPoints += 100; break;
          case MeldType.ThreeJokers: meldPoints += 100; break; // counts as impure
        }
        if ((m.type===MeldType.SequencePure || m.type===MeldType.SetPure) && m.cards.length>=7) {
          hasSevenPure = true;
        }
        for (const c of m.cards) cardPoints += cardValue(c);
      }
      return { meldPoints, cardPoints, hasSevenPure };
    };

    const t0 = tallyTeam(0);
    const t1 = tallyTeam(1);

    // Penalties
    let penalty0 = 0, penalty1 = 0;
    if (!t0.hasSevenPure) penalty0 = -200;
    if (!t1.hasSevenPure) penalty1 = -200;

    // Transfer in-hand cards from loser(s) to winners only applies in final scoring.
    // Interpretation: if a team has penalty (no seven pure), they are the loser for this transfer.
    // If both have or both haven't, then no special transfer? The rule says "the loser team will have
    // to give cards in its hands to the other team". We'll implement: if exactly one team lacks 7-pure,
    // that team's remaining hand cards (both players) are valued and added to the other team's cardPoints.

    const handValues = (teamId: number) => {
      let sum = 0;
      for (const p of this.players.filter(pl=>pl.teamId===teamId)) {
        for (const c of p.hand) sum += cardValue(c);
      }
      return sum;
    };

    let gain0 = 0, gain1 = 0;
    const t0Loser = !t0.hasSevenPure && t1.hasSevenPure;
    const t1Loser = !t1.hasSevenPure && t0.hasSevenPure;
    if (t0Loser) { gain1 += handValues(0); }
    if (t1Loser) { gain0 += handValues(1); }

    const team0Total = t0.meldPoints + t0.cardPoints + penalty0 + gain0;
    const team1Total = t1.meldPoints + t1.cardPoints + penalty1 + gain1;

    details.push({ teamId:0, meldPoints: t0.meldPoints, cardPoints: t0.cardPoints, penalty: penalty0, inHandGainsFromOpp: gain0, comment: summaryComment(t0, penalty0) });
    details.push({ teamId:1, meldPoints: t1.meldPoints, cardPoints: t1.cardPoints, penalty: penalty1, inHandGainsFromOpp: gain1, comment: summaryComment(t1, penalty1) });

    return { teamScores: [team0Total, team1Total], details };

    function summaryComment(tally: {hasSevenPure:boolean}, penalty:number): string {
      if (!tally.hasSevenPure && penalty === -200) return 'No 7-card pure: -200 applied';
      return 'OK';
    }
  }
}

//#endregion

//#region Combination Helper

function kCombinationsIncluding<T>(arr: T[], kMin: number, kMax: number, mustInclude: T): T[][] {
  const res: T[][] = [];
  const idxMap = new Map<T, number[]>();
  arr.forEach((v,i)=>{
    const list = idxMap.get(v) || [];
    list.push(i);
    idxMap.set(v, list);
  });

  const indices = arr.map((_,i)=>i);
  const mustIdx = indices.find(i=>arr[i]===mustInclude);
  if (mustIdx===undefined) return res;

  const choose = (start: number, k: number, chosen: number[]) => {
    if (k===0) {
      if (!chosen.includes(mustIdx)) return;
      const combo = chosen.map(i=>arr[i]);
      res.push(combo);
      return;
    }
    for (let i=start; i<indices.length; i++) {
      chosen.push(indices[i]);
      choose(i+1, k-1, chosen);
      chosen.pop();
    }
  };

  for (let k=kMin;k<=kMax;k++) choose(0, k, []);
  return res;
}

//#endregion

/*
How to integrate (Node/Express + Socket.IO)
------------------------------------------
- Create a single instance per room: const game = new BucaroGame();
- game.addPlayer(... x4); game.startGame();
- Wire socket events to call drawFromClosed/drawFromOpen/placeMelds/addCardsToMeld/discard/show
- Use getPlayerState(socket.userId) to send player-safe state (hides other hands)
- On END, call computeFinalScores() and broadcast results

Next (Phase 2)
--------------
- I can provide the full Socket.IO server + REST bootstrap and a React UI that
  consumes this engine, with drag-and-drop card grouping and validations.
*/
