/* Race routes, mirrored from the client's race missions (neon-drift-city/js/missions.js markers).
   Nodes are road-grid intersections; world position = (i - N/2) * PITCH. Keep in sync with the client. */
const N = 9, PITCH = 76;
const coord = (i) => (i - N / 2) * PITCH;
const ROUTES = {
  downtown: { name: 'Downtown Sprint', nodes: [[3, 3], [3, 7], [6, 7], [6, 5], [8, 5], [8, 2], [5, 2], [5, 3], [3, 3]] },
  harbor: { name: 'Harbor Loop', nodes: [[1, 8], [8, 8], [8, 6], [9, 6], [9, 1], [1, 1], [1, 4], [0, 4], [0, 8], [1, 8]] },
  midtown: { name: 'Midtown Circuit', nodes: [[6, 6], [6, 3], [2, 3], [2, 5], [4, 5], [4, 8], [7, 8], [7, 6], [6, 6]] }
};
for (const r of Object.values(ROUTES)) r.pts = r.nodes.map(([i, j]) => [coord(i), coord(j)]);
/* checkpoint k (1-based, across all laps) -> [x, z] */
function checkpointPos(route, k) { const n = route.pts.length - 1; return route.pts[((k - 1) % n) + 1]; }
function totalCheckpoints(route, laps) { return (route.pts.length - 1) * laps; }
module.exports = { ROUTES, checkpointPos, totalCheckpoints, coord };
