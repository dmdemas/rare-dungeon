# RareDungeon (MVP)

Non-SDK web build for [Rare Friends Vibeathon](https://github.com/spokesz/rarefriends-vibeathon). Simulated economy stubs only — no live contracts, no FriendSDK.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://127.0.0.1:5173`).

## This MVP slice

- Menu shell (wallet / rules / economy stubs)
- Create dungeon: 2 map previews → pick one (no perks) → pool
- Demo dungeon in pool at start
- Play → raid: fog, auto-walk, combat, stamina, 3 floors
- Canvas tilted map, Pause / 1× / 2× (400ms base), Esc surrender
- Win / Dead / Surrender overlays

Next stage: economy, perks, simulator, wallet, phone.
