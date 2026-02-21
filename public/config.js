// ============================================================================
// 40 CAPS — Configuration & Constants
// ============================================================================

export const CONFIG = {
  // Table
  TABLE_SIZE: 600, // px, square playing surface
  TABLE_COLOR: "#2d6a2d",
  TABLE_BORDER_COLOR: "#5a3a1a",
  TABLE_BORDER_WIDTH: 8,
  WALL_THICKNESS: 20, // Rapier wall collider half-thickness

  // Chips
  CHIP_RADIUS: 20, // px (and Rapier units)
  CHIP_TOP_COLOR: "#e63946",
  CHIP_BOTTOM_COLOR: "#f1faee",
  CHIP_BORDER_COLOR: "#1d3557",
  CHIP_BORDER_WIDTH: 2,

  // Physics — EDITABLE friction coefficients
  FRICTION_TABLE: 0.3, // Table surface friction (Rapier collider friction for walls)
  FRICTION_CHIP_TOP: 0.4, // Friction when chip is top-down (top surface contacts table)
  FRICTION_CHIP_BOTTOM: 0.5, // Friction when chip is top-up (bottom surface contacts table)
  DAMPING_SCALE: 12.0, // Multiplier: linear damping = chipFriction * tableFriction * this
  ANGULAR_DAMPING: 10.0, // Quick spin stop
  CHIP_RESTITUTION: 0.3, // Bounciness on chip-chip or chip-wall collision
  VELOCITY_THRESHOLD: 0.6, // Below this speed (Rapier units/s), chip is considered stopped

  // Toss
  TOSS_TOP_PROBABILITY: 0.5,
  TOSS_TRIANGLE_MIN: 40, // Min distance between chips
  TOSS_TRIANGLE_MAX: 180, // Max distance from center
  TOSS_ANIM_DURATION: 600, // ms for toss scatter animation

  // Flick interaction
  FLICK_ANGLE_RANGE: 20, // degrees ±
  FLICK_ANGLE_SPEED: 1.8, // oscillation speed (cycles per second)
  FLICK_POWER_MIN: 50, // min impulse magnitude (~32px travel)
  FLICK_POWER_MAX: 600, // max impulse magnitude (~320px travel)
  FLICK_POWER_SPEED: 1.0, // power oscillation speed (cycles per second)

  // Rendering
  CANVAS_PADDING: 80, // extra space around table for HUD
  ARROW_COLOR: "#ffb703",
  ARROW_WIDTH: 4,
  ARROW_HEAD_LEN: 14,
  ARROW_LENGTH_MIN: 35,
  ARROW_LENGTH_MAX: 120,
  GATE_LINE_COLOR: "rgba(255, 255, 255, 0.4)",

  // Players
  PLAYER_COLORS: [
    "#e63946",
    "#457b9d",
    "#2a9d8f",
    "#e9c46a",
    "#f4a261",
    "#264653",
    "#d62828",
    "#6a4c93",
  ],
};

// ============================================================================
// IMPAIRMENTS & BUFFS
// ============================================================================

export const IMPAIRMENTS = [
  {
    id: "wild_shooter", //Randomly affects angle ±5% and power ±10%
    name: "Wild Shooter",
    abbr: "W",
    desc: "Your accuracy is a little off tonight.",
  },
  {
    id: "daze", //Meters blink on/off randomly
    name: "Daze",
    abbr: "D",
    desc: "It's hard to make out your aim tonight.",
  },
  {
    id: "double_vision", //Ghost copies offset from real
    name: "Double Vision",
    abbr: "V",
    desc: "You're wondering why there are too many chips on the table.",
  },
  {
    id: "blackout", //80% darkness overlay
    name: "Blackout",
    abbr: "B",
    desc: "The night is fading, but you can just make out the target.",
  },
  {
    id: "false_confidence", //
    name: "False Confidence",
    abbr: "F",
    desc: "You're feeling hot tonight, but are you?",
  },
];

export const BUFFS = [
  {
    id: "skilled_shooter", //Angle range narrows to ±10°
    name: "Skilled Shooter",
    abbr: "S",
    desc: "Your aim is more precise.",
  },
  {
    id: "long_shot", //Arrow length 2x
    name: "Long Shot",
    abbr: "L",
    desc: "Seems easier to make those long shots.",
  },
  {
    id: "focus", //Meters move at half speed
    name: "Focus",
    abbr: "F",
    desc: "You take a deep breath and the world slows down.",
  },
  {
    id: "hand_of_god", //Wall hits don't fail
    name: "Hand of God",
    abbr: "H",
    desc: "Fate is on your side.",
  },
  {
    id: "jump_shot", //Chip passes through others
    name: "Jump Shot",
    abbr: "J",
    desc: "You summon powers from another dimension to avoid hitting any chips.",
  },
];
