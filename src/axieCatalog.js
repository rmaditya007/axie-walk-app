/* =============================================================================
   The roster of playable Axies — sourced from the "Axie 3D Assets" pack
   (github.com/jaatster/axie-3d-assets), the beginner-friendly GLB kit called
   out for Axie Vibeathon. Each file is a self-contained glTF 2.0 binary with
   its mesh, textures, skeleton, and Idle/Walk/Run clips embedded — exactly
   what both the map overlay and the 3D World view need.

   We only ship the 7 "mascot" characters here (not the 10 Sapidae variants)
   to keep the app's download size reasonable on a phone; the loader/viewer
   code below works the same for any file from that pack, so adding more is
   just adding a row to this table.

   Usage note: these are Sky Mavis-owned assets licensed for Axie Vibeathon
   and Sky Mavis-approved Axie projects only (see the pack's RIGHTS.md) —
   not a general-purpose asset pack. They ship inside this project's Android
   build under that permission.
   ============================================================================= */

export const DEFAULT_AXIE_ID = 'kotaro';

export const AXIES = [
  { id: 'kotaro', name: 'Kotaro', weapon: 'Sword' },
  { id: 'bing', name: 'Bing', weapon: 'Cannon' },
  { id: 'kibo', name: 'Kibo', weapon: 'Hammer' },
  { id: 'paladill', name: 'Paladill', weapon: 'Hammer' },
  { id: 'pomodoro', name: 'Pomodoro', weapon: 'Staff' },
  { id: 'tripp', name: 'Tripp', weapon: 'Axe' },
  { id: 'xia', name: 'Xia', weapon: 'Axe' },
];

const byId = new Map(AXIES.map((a) => [a.id, a]));

export function getAxie(id) {
  return byId.get(id) || byId.get(DEFAULT_AXIE_ID);
}

export function glbPath(id) {
  return `/axies/${getAxie(id).id}.glb`;
}

export function portraitPath(id) {
  return `/axies/previews/${getAxie(id).id}.png`;
}
