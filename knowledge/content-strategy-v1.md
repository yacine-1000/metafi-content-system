# Metafi Content OS Strategy v1

Metafi Content OS is being reset into a data-backed content production machine, not a generic AI content generator.

The goal is a repeatable operating loop:

1. Content performance data identifies winning patterns.
2. Winning patterns are converted into structured topic banks.
3. Daily generation selects approved master scripts from the bank.
4. The user reviews ready post packages.
5. Approved posts are sent to Buffer later.
6. Posts are scheduled, measured, and used to update the banks.

The intended workflow is:

User clicks Generate Today -> reviews ready post packages -> approves -> sends to Buffer later -> schedules -> measures -> updates banks.

## Core Principle

AI should not invent strategy or scripts.

The bank defines the strategy. The final model is Pillar -> Topic -> Master scripts by hook type. Each topic contains approved master scripts with hook text, visual hook, slide count, CTA slide, slide-by-slide copy, and asset bank routing.

For V1, daily generation should use the selected master script as-is. LLM variation can come later, but only as controlled rewriting of approved scripts. No free invention.

Plain English belongs mainly in this strategy doc. Operating logic should live in machine-readable JSON banks with fixed IDs and enums.

## Locked Pillars

The active pillars and monthly shares are locked for v1:

- p2: Hybrid Athlete / Sport + Gym Balance, 0.4
- p1: Changed Week / What Should I Train Today, 0.25
- p3: Workout Programming / Exercise Selection, 0.25
- p4: Physique / Transformation / Body Proof, 0.1

Inactive pillars should stay inactive by default.

## Locked Text Hooks

The active text hook types are:

- comparison
- listicle
- how_to
- identity_callout

## Locked Visual Hooks

The active visual hook types are:

- physique_proof
- weird_outfit_character
- collage
- basic_pinterest_gym_image

Food and supplement visuals are disallowed for v1.

## Locked CTA

The only allowed CTA type is:

- app_icon_home_screen

CTA should feel subtle. Slide 1 must not contain CTA and should not feel like an app ad.

The Metafi app slide follows script logic. It must not be forced into a fixed global position. Script templates mark which slides can become app slides.

## Account Strategy

All accounts use the same daily selected topics.

Accounts differ only by creative variation:

- topic_variation
- text_hook
- slide_copy
- caption
- visual_asset

The same fields across accounts are:

- pillar_id
- topic_id
- script_template_id
- cta_type

## Slide Rules

Slide count is decided by the selected script template.

Slide 1 must contain the selected visual hook and selected text hook. Slide 1 allows_cta=false.

The template decides which later slides can become the Metafi app slide. The app slide is not globally fixed.
