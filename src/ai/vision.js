'use strict';
// What the configured model can actually do with an image.
//
// Screenshot capture and visual analysis are different things, and the product must
// never blur them. This module is the single place that answers "can the model look
// at a picture?", and the answer today is no:
//
//   * the configured provider (Groq) and model (openai/gpt-oss-120b) take text;
//   * no image-input code path exists in src/ai/provider.js;
//   * no test has ever sent an image to a model.
//
// Until all three change, `supports_image_input` and `tested` are false, and the
// evidence packet reports screenshots as metadata only. If a vision-capable model is
// configured later, enabling it requires implementing the image path and testing it
// against a real provider before this flag may be turned on.
const provider = require('./provider');

// Deliberately hard-coded: a config flag cannot make the product claim vision.
const VISION_IMPLEMENTED = false;

function capability() {
  const cfg = provider.config();
  return {
    supports_image_input: false,
    implemented: VISION_IMPLEMENTED,
    tested: false,
    provider: cfg.provider,
    model: cfg.model,
    analysis_mode: 'text_only',
    reason: 'The configured model is used through a text-only completion path. Screenshots are captured and '
      + 'stored as evidence metadata; they are not sent to a model and no visual claim is derived from them.',
    requirements_to_enable: [
      'a configured model that accepts image input',
      'an image-content branch in src/ai/provider.js',
      'a tested capture-to-prompt path with recorded results'
    ]
  };
}

module.exports = { capability, VISION_IMPLEMENTED };
