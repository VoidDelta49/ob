// WPA-style 8-ball, simplified: open table after break, groups assigned by first legal pot,
// ball in hand anywhere after a foul, early 8 / 8 on a foul loses, 8 on the break is re-spotted.
// Balls jumped off the table: foul; object balls are spotted on the foot spot (APA-style), the 8 off the
// table loses (re-spotted on the break), the cue ball off the table is treated like a scratch.
export const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
export const STRIPES = [9, 10, 11, 12, 13, 14, 15];
export const groupOf = (n) => (n >= 1 && n <= 7 ? 'solids' : n >= 9 && n <= 15 ? 'stripes' : null);
export const groupBalls = (g) => (g === 'solids' ? SOLIDS : g === 'stripes' ? STRIPES : []);

export class EightBall {
  constructor(players) {
    this.players = players.map((p) => ({ ...p, group: null }));
    this.cur = 0;
    this.open = true;
    this.isBreak = true;
    this.ballInHand = true;   // cue ball placed in the kitchen for the break
    this.kitchen = true;
    this.over = false;
    this.winner = null;
  }
  get player() { return this.players[this.cur]; }
  get other() { return this.players[1 - this.cur]; }

  // Balls the current player may legally contact first.
  legalTargets(onTable) {
    const p = this.player;
    const objs = [...onTable].filter((n) => n !== 0);
    if (this.open || !p.group) return objs.filter((n) => n !== 8 || this.isBreak);
    const mine = groupBalls(p.group).filter((n) => onTable.has(n));
    return mine.length ? mine : [8];
  }

  endShot(log, before) {
    const p = this.player, o = this.other;
    const objPotted = log.pocketed.filter((n) => n !== 0);
    const off = log.offTable || [];
    const scratch = log.pocketed.includes(0) || off.includes(0);
    const eight = log.pocketed.includes(8) || off.includes(8);
    const clearedBefore = !!p.group && groupBalls(p.group).every((n) => !before.has(n));
    const res = { foul: null, msg: [], respot8: false, respot: off.filter((n) => n !== 0 && n !== 8), ballInHand: false, switched: false, over: false };

    if (off.includes(0)) res.foul = 'Cue ball off the table';
    else if (scratch) res.foul = 'Scratch';
    else if (log.firstHit === null) res.foul = 'No ball hit';
    else if (!this.open && p.group) {
      const want = clearedBefore ? [8] : groupBalls(p.group);
      if (!want.includes(log.firstHit)) res.foul = 'Wrong ball first';
    } else if (this.open && !this.isBreak && log.firstHit === 8) res.foul = 'Hit the 8 first';
    if (!res.foul && !this.isBreak && objPotted.length === 0 && !log.railAfterContact) res.foul = 'No rail after contact';
    if (!res.foul && off.length) res.foul = 'Ball off the table';

    if (eight) {
      if (this.isBreak) {
        res.respot8 = true;
        res.msg.push('8 on the break — re-spotted');
      } else {
        this.over = true;
        res.over = true;
        if (clearedBefore && !res.foul) { this.winner = this.cur; res.msg.push(`${p.name} sinks the 8 and wins!`); }
        else {
          this.winner = 1 - this.cur;
          if (off.includes(8)) res.msg.push(`8-ball off the table — ${o.name} wins`);
          else res.msg.push(res.foul ? `8-ball on a foul (${res.foul.toLowerCase()}) — ${o.name} wins` : `8-ball pocketed early — ${o.name} wins`);
        }
        return res;
      }
    }

    if (this.open && !this.isBreak && !res.foul) {
      const first = objPotted.find((n) => n !== 8);
      if (first) {
        p.group = groupOf(first);
        o.group = p.group === 'solids' ? 'stripes' : 'solids';
        this.open = false;
        res.msg.push(`${p.name} is ${p.group}`);
      }
    }

    let cont = false;
    if (!res.foul) {
      if (this.isBreak) cont = objPotted.some((n) => n !== 8);
      else if (p.group) cont = objPotted.some((n) => groupOf(n) === p.group);
    }

    this.isBreak = false;
    this.kitchen = false;
    if (res.foul) {
      res.msg.unshift(`Foul: ${res.foul}`);
      res.ballInHand = true;
    }
    if (!cont) { this.cur = 1 - this.cur; res.switched = true; }
    this.ballInHand = res.ballInHand;
    return res;
  }
}
