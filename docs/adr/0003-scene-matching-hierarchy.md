# 0003: Video Release Matching Hierarchy & Exclusions

To rank subtitles accurately against user video filenames, the matching algorithm prioritizes Movie Edition (Cuts), Source, and Streaming Network over arbitrary Release Groups. Streaming platforms (Amazon, Netflix, Disney+) share identical digital master captures and intro timings across different release groups, making Source + Network the strongest cross-group sync predictor. Furthermore, partial tracks (`FORCED` and `CD1`/`CD2` multi-part files) are automatically filtered out to ensure full dialogue playback on single-file video streams.

Subtitles are ranked in 9 priority tiers:
1. Exact Filename Match (100)
2. Edition + Source + Network + Group (95)
3. Edition + Source + Network (90)
4. Edition + Source (85)
5. Source + Network (75)
6. Edition + Source + Group (70)
7. Source + Group (60)
8. Source Only (45)
9. Fuzzy Title Fallback (1–20)
