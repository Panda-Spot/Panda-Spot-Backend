const FACE_ENGINE_URL = process.env.FACE_ENGINE_URL || "http://127.0.0.1:8001";

/**
 * Sends raw image bytes to the face-engine microservice's /detect endpoint
 * and returns the parsed faces array.
 *
 * @param {Buffer} imageBuffer - raw bytes of the image file
 * @param {string} filename - original filename (used for the multipart part / content sniffing)
 * @returns {Promise<{faces: Array<{bbox: number[], embedding: number[], det_score: number}>}>}
 */
export async function detectFaces(imageBuffer, filename) {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer]), filename);

  let response;
  try {
    response = await fetch(`${FACE_ENGINE_URL}/detect`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    const error = new Error(`Could not reach face-engine at ${FACE_ENGINE_URL}: ${err.message}`);
    error.cause = err;
    error.isFaceEngineError = true;
    throw error;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`face-engine returned ${response.status}: ${text || response.statusText}`);
    error.isFaceEngineError = true;
    throw error;
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.faces)) {
    const error = new Error("face-engine returned an unexpected response shape");
    error.isFaceEngineError = true;
    throw error;
  }
  return data;
}

/**
 * Given the `faces` array returned by detectFaces, picks the face with the
 * largest bounding-box area. Returns null if the array is empty.
 */
export function pickLargestFace(faces) {
  if (!faces || faces.length === 0) return null;
  let best = faces[0];
  let bestArea = bboxArea(best.bbox);
  for (let i = 1; i < faces.length; i++) {
    const area = bboxArea(faces[i].bbox);
    if (area > bestArea) {
      best = faces[i];
      bestArea = area;
    }
  }
  return best;
}

function bboxArea(bbox) {
  const [x1, y1, x2, y2] = bbox;
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}
