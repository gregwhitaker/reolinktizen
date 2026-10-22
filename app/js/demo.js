const names = ['Front entrance', 'Driveway', 'Back garden', 'Side gate', 'Garage', 'Patio', 'Upstairs landing', 'Garden shed'];
const colors = ['#597063','#576b75','#6b7958','#596d64','#606b79','#7b7865'];
// Illustrations are explicitly labeled demo. No external footage or network requests.
export function demoScene(id) {
  const hue = colors[id % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${hue}"/><stop offset="1" stop-color="#afbdb0"/></linearGradient><linearGradient id="ground" x2="0" y2="1"><stop stop-color="#647b60"/><stop offset="1" stop-color="#253f32"/></linearGradient><pattern id="lines" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 0H4" stroke="#0c2319" stroke-opacity=".08"/></pattern></defs><rect width="1280" height="720" fill="url(#sky)"/><path d="M0 320Q170 170 370 310T740 280T1280 290V720H0Z" fill="#506852"/><rect y="385" width="1280" height="335" fill="url(#ground)"/><path d="M500 415H720L1070 720H290Z" fill="#a0a69a"/><path d="M515 415H700L1035 720H325Z" fill="#8d978e"/><path d="M0 520L270 375V270L0 200Z" fill="#b8baa8"/><path d="M0 200L270 270L305 250L0 165Z" fill="#354539"/><rect x="48" y="287" width="89" height="120" fill="#354b44"/><path d="M92 287V405M48 345H136" stroke="#8f9e8f" stroke-width="8"/><rect x="840" y="300" width="300" height="190" rx="2" fill="#b5b4a1"/><path d="M803 310L988 202L1172 310Z" fill="#384c43"/><rect x="920" y="360" width="96" height="130" fill="#52675b"/><rect x="1040" y="340" width="62" height="64" fill="#5c7770"/><path d="M0 505H1280" stroke="#435b44" stroke-width="5"/><g fill="#2c513d"><circle cx="80" cy="500" r="83"/><circle cx="195" cy="550" r="80"/><circle cx="1190" cy="482" r="110"/><circle cx="1110" cy="600" r="95"/></g><g fill="#416349"><circle cx="20" cy="570" r="100"/><circle cx="170" cy="650" r="120"/><circle cx="1240" cy="654" r="160"/></g><rect width="1280" height="720" fill="url(#lines)"/><text x="45" y="55" fill="#f0f4e9" font-size="21" font-family="monospace" letter-spacing="3">DEMO CAMERA ${String(id + 1).padStart(2,'0')}</text><text x="45" y="685" fill="#e0e8db" font-size="18" font-family="monospace" letter-spacing="2">ILLUSTRATED PREVIEW · NO LIVE FOOTAGE</text></svg>`;
}

export class DemoClient {
  constructor() { this.demo = true; }
  async connect() { return { channels: await this.channels(), model: 'Demo recorder', name: 'THE DEMO HOME' }; }
  async channels() { return names.map((name, id) => ({ id, name, online: id !== 6, sleeping: false })); }
  async snapshot(id) { return new Blob([demoScene(id)], { type: 'image/svg+xml' }); }
  close() {}
  async logout() {}
}
