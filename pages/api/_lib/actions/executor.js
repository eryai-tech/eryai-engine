import { updateSession, createNotification, notificationExists } from '../db/supabase.js';
import { pushReservation, pushComplaint, pushNeedsHuman } from '../notifications/push.js';
import { sendStaffEmail, sendGuestEmail } from '../notifications/email.js';

// ============================================
// EXECUTE ACTION BASED ON TYPE
// ============================================
export async function executeAction(action, context) {
  const { sessionId, customer, aiConfig, analysisConfig, analysis, isTestMode } = context;

  console.log(`⚙️ Executing action: ${action.action_type} for trigger: ${action.trigger_value}`);

  try {
    switch (action.action_type) {
      case 'create_notification':
        await handleCreateNotification(action, context);
        break;

      case 'email_staff':
        await handleEmailStaff(action, context);
        break;

      case 'email_guest':
        await handleEmailGuest(action, context);
        break;

      case 'handoff':
        await handleHandoff(action, context);
        break;

      default:
        console.log(`Unknown action type: ${action.action_type}`);
    }
  } catch (err) {
    console.error(`Error executing action ${action.action_type}:`, err);
  }
}

// ============================================
// EXECUTE MULTIPLE ACTIONS FOR TRIGGER
// ============================================
export async function executeActionsForTrigger(trigger, actions, context) {
  const matchingActions = actions.filter(
    a => a.trigger_type === 'analysis' && a.trigger_value === trigger
  );

  for (const action of matchingActions) {
    await executeAction(action, context);
  }
}

// ============================================
// ACTION HANDLERS
// ============================================
async function handleCreateNotification(action, context) {
  const { sessionId, customer, analysis } = context;
  const config = action.action_config || {};

  // Check if notification already exists
  const exists = await notificationExists(sessionId, config.type);
  if (exists) {
    console.log(`Notification type ${config.type} already exists for session`);
    return;
  }

  // Build summary based on type
  let summary = '';
  if (config.type === 'reservation') {
    summary = `Reservation ${analysis.reservation_date} kl ${analysis.reservation_time}, ${analysis.party_size} pers`;
    if (analysis.special_requests) summary += `, ${analysis.special_requests}`;
  } else if (config.type === 'complaint') {
    summary = analysis.needs_human_reason || 'Gäst har uttryckt missnöje';
  } else {
    summary = analysis.needs_human_reason || 'Gäst har frågor som behöver svar';
  }

  const notification = await createNotification({
    customer_id: customer.id,
    session_id: sessionId,
    type: config.type,
    priority: config.priority || 'normal',
    status: 'unread',
    summary,
    guest_name: analysis.guest_name,
    guest_email: analysis.guest_email,
    guest_phone: analysis.guest_phone,
    reservation_details: config.type === 'reservation' ? {
      date: analysis.reservation_date,
      time: analysis.reservation_time,
      party_size: analysis.party_size,
      special_requests: analysis.special_requests
    } : null
  });

  if (notification) {
    // Mark session as needs_human
    await updateSession(sessionId, { needs_human: true });
    console.log(`✅ Notification created: ${notification.id} (${config.type})`);

    // Send push notification
    await sendPushForTrigger(action.trigger_value, customer.id, sessionId, analysis);
  }
}

async function handleEmailStaff(action, context) {
  const { sessionId, customer, aiConfig, analysisConfig, analysis, isTestMode } = context;
  const config = action.action_config || {};

  await sendStaffEmail({
    customer,
    aiConfig,
    analysisConfig,
    analysis,
    sessionId,
    templateName: config.template,
    isTestMode
  });
}

async function handleEmailGuest(action, context) {
  const { customer, aiConfig, analysisConfig, analysis, isTestMode } = context;
  const config = action.action_config || {};

  await sendGuestEmail({
    customer,
    aiConfig,
    analysisConfig,
    analysis,
    templateName: config.template,
    isTestMode
  });
}

async function handleHandoff(action, context) {
  const { sessionId, customer, analysis } = context;

  await updateSession(sessionId, { needs_human: true });
  console.log('✅ Session marked for handoff');

  // Send push notification
  await sendPushForTrigger(action.trigger_value, customer.id, sessionId, analysis);
}

// ============================================
// SEND PUSH BASED ON TRIGGER TYPE
// ============================================
async function sendPushForTrigger(triggerValue, customerId, sessionId, analysis) {
  switch (triggerValue) {
    case 'reservation_complete':
      await pushReservation(customerId, sessionId, analysis);
      break;
    case 'is_complaint':
      await pushComplaint(customerId, sessionId, analysis.guest_name);
      break;
    case 'needs_human_response':
      await pushNeedsHuman(customerId, sessionId, analysis.guest_name);
      break;
  }
}

// ============================================
// CHECK KEYWORD TRIGGERS
// ============================================
export function checkKeywordTriggers(prompt, actions) {
  const promptLower = prompt.toLowerCase();
  const triggered = [];

  for (const action of actions) {
    if (action.trigger_type === 'analysis') continue;

    let isTriggered = false;

    if (action.trigger_type === 'keyword') {
      isTriggered = promptLower.includes(action.trigger_value.toLowerCase());
    } else if (action.trigger_type === 'regex') {
      try {
        const regex = new RegExp(action.trigger_value, 'i');
        isTriggered = regex.test(prompt);
      } catch (e) {
        console.error('Invalid regex:', action.trigger_value);
      }
    }

    if (isTriggered) {
      triggered.push(action);
      console.log(`⚡ Action triggered: ${action.action_type} (${action.trigger_value})`);
    }
  }

  return triggered;
}
