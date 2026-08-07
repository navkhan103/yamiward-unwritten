# YAMIWARD: UNWRITTEN

A browser fighting game set in the Ward (闇区). Eight champions, one per bloodline,
fighting for the Seat — the one chair from which the Codex can be amended.

**Play:** https://navkhan103.github.io/yamiward-unwritten/

## Controls

| | Player 1 | Player 2 |
|---|---|---|
| Walk | `A` / `D` | `←` / `→` |
| Sidestep | `W` / `S` | `↑` / `↓` |
| Crouch | `S` | `↓` |
| Light | `J` | `Num1` |
| Heavy | `K` | `Num2` |
| Low | `L` | `Num3` |
| Special | `I` | `Num5` |
| Super | `U` | `Num0` |

Gamepad is supported: X light, Y heavy, A low, B special, RB/RT super.

## The roster

| Champion | Form | Bloodline | Sign |
|---|---|---|---|
| TETSUKI 鉄鬼 | Grappler | Oni 鬼 | Aquarius |
| YUKIWARI 雪割 | Zoner | Yukionna 雪女 | Capricorn |
| RAIGA 雷牙 | Rushdown | Raiju 雷獣 | Leo |
| MAYOI 迷 | Trickster | Kitsune 狐 | Pisces |
| SHIGURE 時雨 | Trickster | Ameonna 雨女 | Gemini |
| TSUKIMI 月見 | Rushdown | Tsukiusagi 月兎 | Virgo |
| KAZAKIRI 風切 | Zoner | Tengu 天狗 | Scorpio |
| YUMIHARI 弓張 | Rushdown | Ryu 龍 | Sagittarius |

Rival pairs are astrological opposites, so every grudge fight is a polarity fight.

## Notes

Buildless — no bundler, no install. Every module is served as-is and `three` is
mapped through an import map, so this deploys as plain static files.

Character art is rendered from per-fighter LoRAs and assembled at runtime as
textured paper-doll rigs (see `src/paperdoll.js`): each fighter is ~10 pieces
hung off a joint hierarchy, with robe and wing variants where a costume has no
separable legs. Frame data lives in `src/moves.js` and is meant to be edited.

Balance is first-pass and unplaytested. Feedback welcome.
