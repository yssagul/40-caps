# 40 Caps

A browser-based chip-flicking multiplayer game with real-time online play. Flick chips through gates formed by other chips on the table. The player with the fewest failures wins.

## How to Play

### Setup
- **Local Play**: 2-8 players share one screen, taking turns
- **Online Play**: Create a room with a 4-digit code and share it with friends

### Rules

1. **Toss**: The tosser scatters 3 chips onto the table in a random triangle formation
2. **Flick**: Players take turns flicking one chip through the "gate" formed by the other two chips
3. **Aim**: Click to lock the oscillating angle meter, then click to lock the oscillating power meter
4. **Success**: The chip must pass through the gate without touching the gate chips or hitting a wall
5. **Failure**: If the flick fails, the failing player re-tosses the chips and the next player flicks first
6. **Scoring**: Each failure adds 1 point. **Lowest score wins** when the host ends the game

### Impairments (Debuffs)
Every 5 failures, a player gains a random impairment:
- **Wild Shooter** (W) - Randomly affects your angle and power
- **Daze** (D) - Your aiming meters blink on and off
- **Double Vision** (V) - Ghost copies of the table appear offset from real positions
- **Blackout** (B) - Darkness overlay obscures most of the table
- **False Confidence** (F) - Your angle meter looks more precise than it actually is

Impairments are cured by getting 5 successful flicks in a row.

### On Fire Buffs
Getting 3 successful flicks in a row grants a random temporary buff (lasts one flick):
- **Skilled Shooter** (S) - Angle range narrows for more precision
- **Long Shot** (L) - Aiming arrow extends further for better visibility
- **Focus** (F) - Oscillating meters move at half speed
- **Hand of God** (H) - Wall hits don't count as failures
- **Jump Shot** (J) - Your chip passes through other chips

### Online Multiplayer
- In online mode, each player only sees their own impairments and buffs
- Other players' impairments are hidden (you only see badge counts)
- All tosses and flicks are visible to all players in real-time

## Running Locally

### Prerequisites
- [Node.js](https://nodejs.org/) 18 or higher

### Setup
```bash
cd 40_caps
npm install
npm start
```

The server starts at `http://localhost:10000`. Open this URL in your browser.

## Deploying to Render.com

1. Push this repository to GitHub
2. Go to [Render.com](https://render.com) and create a new **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
5. Deploy

Render.com provides HTTPS and WebSocket support automatically. Share the provided URL with friends to play online.

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES Modules), HTML5 Canvas
- **Physics**: [Rapier.js](https://rapier.rs/) 2D (WASM-based, loaded from esm.sh CDN)
- **Backend**: Node.js, Express, WebSocket (ws)
- **Deployment**: Render.com compatible

## Advanced Settings

Physics parameters can be tuned before starting a game:
- **Table Friction** - Surface friction of the table
- **Chip Top/Bottom Friction** - Friction based on chip orientation
- **Damping Scale** - How quickly chips slow down
- **Chip Restitution** - Bounciness on collisions

## Project Structure

```
40_caps/
  server.js        - Node.js WebSocket + Express server
  package.json     - Dependencies and scripts
  public/          - Static files served to browser
    index.html     - Game UI and lobby
    style.css      - Dark theme styling
    game.js        - Core game logic with Rapier physics
    net.js         - Client-side WebSocket networking
```
