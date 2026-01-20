const PUSH_API_URL = 'https://dashboard.eryai.tech/api/push/send';

// ============================================
// SEND PUSH NOTIFICATION
// ============================================
export async function sendPush(customerId, { title, body, data = {} }) {
  try {
    const response = await fetch(PUSH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId,
        title,
        body,
        data
      })
    });

    const result = await response.json();

    if (response.ok) {
      console.log(`✅ Push sent: ${result.sent}/${result.total} devices`);
      return { success: true, sent: result.sent, total: result.total };
    } else {
      console.error('Push API error:', result);
      return { success: false, error: result };
    }
  } catch (err) {
    console.error('Failed to send push:', err);
    return { success: false, error: err.message };
  }
}

// ============================================
// PUSH FOR NEW GUEST MESSAGE (human took over)
// ============================================
export async function pushNewGuestMessage(customerId, sessionId, guestName, message) {
  const truncatedMessage = message.length > 50 
    ? message.substring(0, 50) + '...' 
    : message;

  return sendPush(customerId, {
    title: '💬 Nytt meddelande',
    body: `${guestName}: ${truncatedMessage}`,
    data: {
      sessionId,
      type: 'new_message',
      guestName
    }
  });
}

// ============================================
// PUSH FOR RESERVATION
// ============================================
export async function pushReservation(customerId, sessionId, analysis) {
  const { guest_name, reservation_date, reservation_time, party_size } = analysis;

  return sendPush(customerId, {
    title: '📅 Ny bokning!',
    body: `${guest_name || 'Gäst'} vill boka ${reservation_date || ''} kl ${reservation_time || ''} för ${party_size || '?'} pers`,
    data: {
      sessionId,
      type: 'reservation',
      guestName: guest_name
    }
  });
}

// ============================================
// PUSH FOR COMPLAINT
// ============================================
export async function pushComplaint(customerId, sessionId, guestName) {
  return sendPush(customerId, {
    title: '⚠️ Klagomål',
    body: `${guestName || 'En gäst'} har uttryckt missnöje`,
    data: {
      sessionId,
      type: 'complaint',
      guestName
    }
  });
}

// ============================================
// PUSH FOR NEEDS HUMAN RESPONSE
// ============================================
export async function pushNeedsHuman(customerId, sessionId, guestName) {
  return sendPush(customerId, {
    title: '💬 Behöver svar',
    body: `${guestName || 'En gäst'} har en fråga som behöver ditt svar`,
    data: {
      sessionId,
      type: 'needs_human',
      guestName
    }
  });
}
