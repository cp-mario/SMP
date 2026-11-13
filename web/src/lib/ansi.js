const COLORS = {
  30:"#3f3f46",31:"#ef4444",32:"#22c55e",33:"#eab308",34:"#3b82f6",35:"#d946ef",36:"#06b6d4",37:"#d4d4d8",
  90:"#71717a",91:"#f87171",92:"#4ade80",93:"#facc15",94:"#60a5fa",95:"#e879f9",96:"#22d3ee",97:"#fafafa"
};
const BG = {
  40:"#27272a",41:"#7f1d1d",42:"#14532d",43:"#713f12",44:"#1e3a8a",45:"#701a75",46:"#155e75",47:"#a1a1aa",
  100:"#3f3f46",101:"#991b1b",102:"#166534",103:"#854d0e",104:"#1d4ed8",105:"#86198f",106:"#0e7490",107:"#e4e4e7"
};
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
export function ansiToHtml(input){
  const s = String(input ?? "");
  const re = /\x1b\[([0-9;]*)m/g;
  let out = "", last = 0, m, st = { fg:null,bg:null,bold:false,dim:false,italic:false,ul:false };
  const span = () => {
    const css = [];
    if (st.fg) css.push(`color:${st.fg}`);
    if (st.bg) css.push(`background:${st.bg}`);
    if (st.bold) css.push("font-weight:700");
    if (st.dim) css.push("opacity:.7");
    if (st.italic) css.push("font-style:italic");
    if (st.ul) css.push("text-decoration:underline");
    return css.length ? `<span style="${css.join(";")}">` : "";
  };
  let open = false;
  while ((m = re.exec(s))) {
    const chunk = esc(s.slice(last, m.index));
    if (chunk) { if (!open) { out += span(); open = true; } out += chunk; }
    last = re.lastIndex;
    const codes = (m[1] || "0").split(";").filter(Boolean).map(Number);
    if (!codes.length) codes.push(0);
    for (const c of codes) {
      if (c === 0) st = { fg:null,bg:null,bold:false,dim:false,italic:false,ul:false };
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.ul = true;
      else if (c === 22) { st.bold=false; st.dim=false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.ul = false;
      else if (COLORS[c]) st.fg = COLORS[c];
      else if (BG[c]) st.bg = BG[c];
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
    }
    if (open) { out += "</span>"; open = false; }
  }
  const tail = esc(s.slice(last));
  if (tail) { if (!open) out += span(); out += tail + "</span>"; open = false; }
  else if (open) out += "</span>";
  return out;
}
