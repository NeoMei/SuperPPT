export const SLIDE_WIDTH_PX = 1280;
export const SLIDE_HEIGHT_PX = 720;
export const SOURCE_WIDTH_PX = 1920;
export const SOURCE_HEIGHT_PX = 1080;
export const PDF_WIDTH_POINTS = 960;
export const PDF_HEIGHT_POINTS = 540;

export const pxToX = (px: number): number => px * SLIDE_WIDTH_PX / SOURCE_WIDTH_PX;
export const pxToY = (px: number): number => px * SLIDE_HEIGHT_PX / SOURCE_HEIGHT_PX;
export const pxToPt = (px: number): number => px * 72 / 96;

export const SLIDE_WIDTH_IN = 13.333;
export const SLIDE_HEIGHT_IN = 7.5;
export const pxToInchX = (px: number): number => px * SLIDE_WIDTH_IN / SLIDE_WIDTH_PX;
export const pxToInchY = (px: number): number => px * SLIDE_HEIGHT_IN / SLIDE_HEIGHT_PX;

export const position = (bbox: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  left: pxToX(bbox.x),
  top: pxToY(bbox.y),
  width: pxToX(bbox.width),
  height: pxToY(bbox.height),
});
