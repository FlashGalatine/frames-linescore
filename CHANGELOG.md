# Changelog

All notable changes to **Frames** are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- The control panel says when both names are still the defaults, because some themes stay hidden until real team names are set and Show board can look broken.
- `linescore:error` now reaches the page: `panel-core.js` dispatches it, and the control panel shows it in its status line until the next good update.
- Ballpark starts hidden until its first state, so there's no small empty frame before it or with Streamer.bot off.
- A panel box catches up with live state when it loses focus, and a rejected value goes back to the current one when its command times out.
- Enter in a panel text field now does the same as Set.

## [0.1.0] - 2026-11-02

First release.

### Added

- `Linescore Command` and `Linescore Push` actions: fixed points per inning or free entry, an extra inning on a tie, undo, presets for SFL and baseball, and Ball, Strike and Out counts that can be switched off and renamed.
- A repeat guard on `t1win`, `t2win`, `undo` and `next`, so two people entering the same thing within 30 seconds count once.
- `frames-shared/panel-core.js`, the transport, and `frames-shared/control.html`, the control panel.
- The `ballpark` stock theme, with `crosley` and `led` CSS-only skins.
- A mock Streamer.bot, and test suites that run one scenario table against both the mock and the real C#.
