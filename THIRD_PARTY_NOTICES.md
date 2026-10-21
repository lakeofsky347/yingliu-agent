# Third-party notices

Project-owned code and the user-owned workpack data included in this repository are distributed under Apache-2.0; see LICENSE and NOTICE. Third-party components retain the licenses and copyright notices listed below.

- Graph editor: `@comfyorg/litegraph` 0.17.2, Comfy-Org, MIT. The client bundles its independent graph kernel; its complete license is in `licenses/LiteGraph-MIT.txt`. Source: https://github.com/Comfy-Org/litegraph.js/tree/v0.17.2
- Browser driver: `playwright-core` 1.63.0, Microsoft contributors, Apache-2.0. Production dependency; license and notices are distributed with the package.
- Project archive codec: `fflate` 0.8.3, Arjun Barrett, MIT. Its license is distributed in `licenses/fflate-MIT.txt` and its production package.
- Desktop shell: Electron 44.5.1, MIT; its bundled Chromium/Node dependencies and notices remain in the Electron distribution. React and React DOM 18.3.1, MIT, are bundled into the editor UI. This app has no DSH runtime dependency and does not redistribute ComfyUI or its Python inference backend.
- Core editor, project store, renderer and audio modules were extracted and adapted from the user's local dsh-video-studio 0.2.0, originally distributed under MIT. The complete historical repository MIT notice, including the DSH Video Studio and Yingliu Studio copyright notices, is preserved in `licenses/Legacy-MIT.txt`; provenance and attribution are also recorded in NOTICE. Project-owned additions are distributed under the root Apache-2.0 license.
- The frame contract and capture/encoding approach are adapted from the user's local frontend-video-foundation workpack 0.1.0. Original recipe/profile/template data is copied into `packs/foundation` with source hashes and its `design_proposal` status preserved. The user-owned workpack data included in this application is distributed under the repository's Apache-2.0 license; unrelated third-party assets and fonts are not copied.
- Chrome/Chromium, FFmpeg and system fonts are used from the user's configured local environment; binaries and fonts are not included in this package.
