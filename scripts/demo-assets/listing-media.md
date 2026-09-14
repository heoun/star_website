# Local listing examples

`demo-listing-media.mjs` adds two sample photographs, a per-unit SVG floor-plan illustration and a short MP4 slideshow to listings in the isolated role demo. Images reuse the repository's `site/jpg/rental-bkg.jpeg` and `site/jpg/unit-bkg.jpeg`; they are sample interiors, not photographs of the synthetic units. The floor plan includes the property's name, unit and current bedroom count, and explicitly says it is mock and not to scale.

`listing-preview-mock.mp4` is a six-second, silent slideshow of those same two images (H.264, 960 × 640). It is served only by the local demo. Each listing has separate media records and URLs. Publication state and existing media are preserved. Removing demo media does not cause it to be added again on the next save or restart.
