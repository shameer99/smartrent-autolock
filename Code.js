const PROPERTY_LAST_STATUS_IS_LOCKED = "LAST_STATUS_IS_LOCKED";
const PROPERTY_LOCK_DEVICE_ID = "LOCK_DEVICE_ID";
const PROPERTY_LOGIN_EMAIL = "LOGIN_EMAIL";
const PROPERTY_LOGIN_PASSWORD = "LOGIN_PASSWORD";
const PROPERTY_CHAT_WEBHOOK_URL = "CHAT_WEBHOOK_URL";
const PROPERTY_LAST_UNLOCKED_TIME = "LAST_UNLOCKED_TIME";
const PROPERTY_STATUS_CHECK_TRIGGER_ID = "STATUS_CHECK_TRIGGER_ID";
const PROPERTY_AUTO_LOCK_TRIGGER_ID = "AUTO_LOCK_TRIGGER_ID";
const PROPERTY_ACCESS_TOKEN = "ACCESS_TOKEN";
const PROPERTY_TOKEN_EXPIRY = "TOKEN_EXPIRY";
const AUTO_LOCK_TIME_MINUTES = 2;

/**
 * Client for interacting with the SmartRent API
 */
class SmartRentClient {
  constructor() {
    this.scriptProperties = PropertiesService.getScriptProperties();
    this.baseUrl = "https://control.smartrent.com/api/v2";
    this.commonHeaders = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-appversion": "chrome-resweb-133.0.0"
    };
  }

  static getInstance() {
    if (!SmartRentClient._instance) {
      SmartRentClient._instance = new SmartRentClient();
    }
    return SmartRentClient._instance;
  }

  getStoredToken() {
    const token = this.scriptProperties.getProperty(PROPERTY_ACCESS_TOKEN);
    const expiryStr = this.scriptProperties.getProperty(PROPERTY_TOKEN_EXPIRY);
    
    if (!token || !expiryStr) return null;
    
    const expiry = new Date(expiryStr);
    if (expiry <= new Date()) return null;
    
    return { token, expiry };
  }

  storeToken(token) {
    // Set expiry to 23 hours from now (SmartRent tokens typically last 24 hours)
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + 23);
    
    this.scriptProperties.setProperties({
      [PROPERTY_ACCESS_TOKEN]: token,
      [PROPERTY_TOKEN_EXPIRY]: expiry.toISOString()
    });
  }

  getAccessToken() {
    const storedToken = this.getStoredToken();
    if (storedToken) return storedToken.token;

    const url = "https://control.smartrent.com/authentication/sessions";
    const options = {
      method: "POST",
      headers: this.commonHeaders,
      payload: JSON.stringify({
        email: this.scriptProperties.getProperty(PROPERTY_LOGIN_EMAIL),
        password: this.scriptProperties.getProperty(PROPERTY_LOGIN_PASSWORD)
      })
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      throw new Error(`Failed to get access token: ${response.getContentText()}`);
    }

    const accessToken = JSON.parse(response.getContentText()).access_token;
    this.storeToken(accessToken);
    return accessToken;
  }

  makeRequest(path, options) {
    const token = this.getAccessToken();
    const url = `${this.baseUrl}${path}`;
    
    const fullOptions = {
      ...options,
      headers: {
        ...this.commonHeaders,
        ...options.headers,
        authorization: `Bearer ${token}`
      }
    };

    const response = UrlFetchApp.fetch(url, fullOptions);
    if (response.getResponseCode() !== 200) {
      throw new Error(`Request failed: ${response.getContentText()}`);
    }

    return JSON.parse(response.getContentText());
  }

  getDeviceLockState() {
    const deviceId = this.scriptProperties.getProperty(PROPERTY_LOCK_DEVICE_ID);
    const response = this.makeRequest(`/devices/${deviceId}`, { method: "GET" });
    
    const isLocked = response.attributes.find(
      (attribute) => attribute.name === "locked"
    )?.state === "true";

    Logger.log(`Device ${response.name} is ${isLocked ? "locked" : "unlocked"}`);
    return isLocked;
  }

  lockDevice() {
    const deviceId = this.scriptProperties.getProperty(PROPERTY_LOCK_DEVICE_ID);
    this.makeRequest(`/devices/${deviceId}`, {
      method: "PATCH",
      payload: JSON.stringify({
        attributes: [{ state: "true", name: "locked" }]
      })
    });
  }
}

/**
 * Checks if the lock status has changed and sends a notification if it has.
 */
function checkStatusNotifyIfChanged() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const lastStatusIsLocked =
    scriptProperties.getProperty(PROPERTY_LAST_STATUS_IS_LOCKED) === "true";
  const currentStatusIsLocked = SmartRentClient.getInstance().getDeviceLockState();

  if (lastStatusIsLocked === currentStatusIsLocked) {
    Logger.log("Lock status is the same as last time, no need to notify");
    return;
  }

  Logger.log(
    `Lock status changed from ${
      lastStatusIsLocked ? "locked" : "unlocked"
    } to ${currentStatusIsLocked ? "locked" : "unlocked"}`
  );

  // Only update last unlocked time when door becomes unlocked
  if (!currentStatusIsLocked) {
    scriptProperties.setProperty(
      PROPERTY_LAST_UNLOCKED_TIME,
      new Date().toISOString()
    );
    Logger.log("Door became unlocked - storing timestamp for auto-lock tracking");
  }

  const emoji = currentStatusIsLocked ? "🔐" : "🔓";
  const status = currentStatusIsLocked ? "LOCKED" : "UNLOCKED";
  const message = `${emoji} Front Door is now ${status}`;
  sendChatNotification(message);

  scriptProperties.setProperty(
    PROPERTY_LAST_STATUS_IS_LOCKED,
    currentStatusIsLocked.toString()
  );
}

/**
 * Sends a notification message to Google Chat.
 * @param {string} messageText - The text message to send
 */
function sendChatNotification(messageText) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const webhookUrl = scriptProperties.getProperty(PROPERTY_CHAT_WEBHOOK_URL);
  const message = { text: messageText };

  const options = {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(message),
  };

  UrlFetchApp.fetch(webhookUrl, options);
}

function testSendChatNotification(emoji = "🔐", status = "LOCKED") {
  const message = `${emoji} Front Door is now ${status}`;
  sendChatNotification(message);
}

/**
 * Gets the lock state of a device.
 * @returns {boolean} True if the device is locked, false otherwise.
 */
function getIsDeviceLocked() {
  const accessToken = getAccessToken();
  const deviceId = PropertiesService.getScriptProperties().getProperty(
    PROPERTY_LOCK_DEVICE_ID
  );
  const url = `https://control.smartrent.com/api/v2/devices/${deviceId}`;

  const options = {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      authorization: `Bearer ${accessToken}`,
      priority: "u=1, i",
      "sec-ch-ua":
        '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "x-appversion": "chrome-resweb-133.0.0",
    },
  };

  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error(
      `Failed to get lock state.\nResponse code: ${response.getResponseCode()}\nResponse: ${response.getContentText()}`
    );
  }
  const responseJson = JSON.parse(response.getContentText());
  const isLocked =
    responseJson.attributes.find((attribute) => attribute.name === "locked")
      ?.state === "true";
  
  Logger.log(
    `Device ${responseJson.name} is ${isLocked ? "locked" : "unlocked"}`
  );
  return isLocked;
}

/**
 * Gets the access token for the SmartRent API.
 * @returns {string} The access token.
 */
function getAccessToken() {
  const url = "https://control.smartrent.com/authentication/sessions";

  const options = {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "sec-ch-ua":
        '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
    payload: JSON.stringify({
      email:
        PropertiesService.getScriptProperties().getProperty(
          PROPERTY_LOGIN_EMAIL
        ),
      password: PropertiesService.getScriptProperties().getProperty(
        PROPERTY_LOGIN_PASSWORD
      ),
    }),
  };

  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error(
      `Failed to get access token.\nResponse code: ${response.getResponseCode()}\nResponse: ${response.getContentText()}`
    );
  }
  return JSON.parse(response.getContentText()).access_token;
}

/**
 * Checks if the door has been unlocked for longer than AUTO_LOCK_TIME_MINUTES
 * and automatically locks it if needed.
 */
function maybeAutoLock() {
  checkStatusNotifyIfChanged();
  const scriptProperties = PropertiesService.getScriptProperties();
  const lastStatusIsLocked =
    scriptProperties.getProperty(PROPERTY_LAST_STATUS_IS_LOCKED) === "true";
  const lastUnlockedTime = new Date(
    scriptProperties.getProperty(PROPERTY_LAST_UNLOCKED_TIME)
  );

  if (lastStatusIsLocked) {
    Logger.log("Door is already locked, no auto-lock needed");
    return;
  }

  const currentTime = new Date();

  Logger.log(`Last unlocked time (ISO): ${lastUnlockedTime.toISOString()}`);
  Logger.log(`Current time (ISO): ${currentTime.toISOString()}`);
  Logger.log(`Time difference (ms): ${currentTime - lastUnlockedTime}`);

  const minutesUnlocked = (currentTime - lastUnlockedTime) / (1000 * 60);

  if (minutesUnlocked >= AUTO_LOCK_TIME_MINUTES) {
    Logger.log(
      `Door has been unlocked for ${minutesUnlocked.toFixed(
        1
      )} minutes, auto-locking...`
    );
    
    try {
      SmartRentClient.getInstance().lockDevice();
      scriptProperties.setProperty(PROPERTY_LAST_STATUS_IS_LOCKED, "true");
      
      sendChatNotification(
        "🔐 Front Door was auto-locked after being unlocked for " +
          AUTO_LOCK_TIME_MINUTES +
          " minutes"
      );
    } catch (error) {
      sendChatNotification(
        "🚨 Front Door auto-locked FAILED after being unlocked for " +
          AUTO_LOCK_TIME_MINUTES +
          " minutes. LOCK MANUALLY!!!"
      );
      throw error;
    }
  } else {
    Logger.log(
      `Door has been unlocked for ${minutesUnlocked.toFixed(
        1
      )} minutes, not auto-locking yet`
    );
  }
}

function lockDevice() {
  const accessToken = getAccessToken();
  const deviceId = PropertiesService.getScriptProperties().getProperty(
    PROPERTY_LOCK_DEVICE_ID
  );
  const url = `https://control.smartrent.com/api/v2/devices/${deviceId}`;

  const options = {
    method: "PATCH",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "x-appversion": "chrome-resweb-133.0.0",
    },
    payload: JSON.stringify({
      attributes: [
        {
          state: "true",
          name: "locked",
        },
      ],
    }),
  };

  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    sendChatNotification(
      "🚨 Front Door auto-locked FAILED after being unlocked for " +
        AUTO_LOCK_TIME_MINUTES +
        " minutes.  LOCK MANUALLY!!!"
    );
    throw new Error(
      `Failed to lock device.\nResponse code: ${response.getResponseCode()}\nResponse: ${response.getContentText()}`
    );
  }
}