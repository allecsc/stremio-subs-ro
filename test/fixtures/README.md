# RAR fixture provenance

`node-unrar-srt-test.rar` is a 288-byte test-only derivative of the MIT-licensed
official `node-unrar-js` `testFiles/WithComment.rar` fixture at commit
`8c615868c9e2ec5ef2e661c5bcaee20ffad3862c`:
https://github.com/YuJianrong/node-unrar.js/tree/8c615868c9e2ec5ef2e661c5bcaee20ffad3862c/testFiles

Its two equal-length `.txt` entry-name extensions were changed to `.srt`, and
the affected RAR4 header CRCs were recomputed. Archive payloads are unchanged.
The fixture exercises `node-unrar-js`'s real header-listing and extraction path
without contacting Subs.ro.

- Original `WithComment.rar` SHA-256: `5CB29DE64C1257FCDA68B8523FAD365766C5D7D511061AD7AC12C14EC4862494`
- Derivative SHA-256: `215EDCB5633289F9F8596016D42369058CE873E0B81A9FC7980B035D9C8253A3`
