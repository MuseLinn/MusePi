import { defineSlot } from "@musepi/client-ui-slots";

/** Composer seats. */
export const COMPOSER_BAR_SLOT = defineSlot("conversation.composer.bar");
export const COMPOSER_DOCK_SLOT = defineSlot("conversation.composer.dock");
export const COMPOSER_INPUT_DOCK_SLOT = defineSlot("conversation.input.dock");
export const COMPOSER_LEFT_SLOT = defineSlot("conversation.input.left");
export const COMPOSER_RIGHT_SLOT = defineSlot("conversation.input.right");
export const COMPOSER_MODEL_SLOT = defineSlot("conversation.input.model");
export const COMPOSER_ATTACHMENTS_SLOT = defineSlot("conversation.input.attachments");
export const COMPOSER_PERMISSION_SLOT = defineSlot("conversation.input.permission");
export const COMPOSER_PLAN_SLOT = defineSlot("conversation.input.plan");
export const COMPOSER_ACTIVITY_SLOT = defineSlot("conversation.input.activity");
export const COMPOSER_OVERLAY_SLOT = defineSlot("conversation.input.overlay");
export const COMPOSER_REQUEST_DRAFT_SLOT = defineSlot("conversation.input.requestDraft");
export const COMPOSER_FOR_SLOT = defineSlot("conversation.input.for");

/** Welcome (hero) seats. */
export const HERO_FRAME_SLOT = defineSlot("conversation.hero.frame");
export const HERO_BRAND_MARK_SLOT = defineSlot("conversation.hero.brand.mark");
export const HERO_WORKSPACE_SLOT = defineSlot("conversation.hero.workspace");
export const HERO_AGENT_PRESET_SLOT = defineSlot("conversation.hero.agentPreset");
export const HERO_OPTIONS_SLOT = defineSlot("conversation.hero.options");

/** One chat-node seat, dispatched by node kind. */
export const CONVERSATION_CHAT_NODE_SLOT = defineSlot("conversation.chat.node");

/** Session-info card sections (`chat.session-info.<id>`). */
export const SESSION_INFO_SLOT_PREFIX = "chat.session-info.";
export const SESSION_INFO_SLOT = `${SESSION_INFO_SLOT_PREFIX}plugins`;
export const SESSION_INFO_AGENTS_SLOT = `${SESSION_INFO_SLOT_PREFIX}agents`;
