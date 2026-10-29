/* global Parse, hello */
import * as session from "../annotation/session.js";
import * as api from "../annotation/api.js";
import {el, setChildren} from "../annotation/dom.js";

const loadConfig = async () => {
  const res = await fetch("/config.json");

  return res.json();
};

export const init = async () => {
  const mock = api.isMock();
  let config = {};
  try {
    config = await loadConfig();
  } catch (err) {
    if (!mock) {
      throw err;
    }
    console.log("no config.json, continuing in mock mode");
  }
  const {
    parseAppId,
    serverURL,
    githubClientId,
    oauth_proxy,
    redirect_uri
  } = config;

  if (!mock) {
    Parse.initialize(parseAppId);
    Parse.serverURL = serverURL; // "http://localhost:1337/parse"
  }

  const authData = {
    authData: {
      access_token: 'TO_REPLACE',
      id: githubClientId
    }
  };

  if (!mock) {
    hello.init({ github: githubClientId }, { oauth_proxy, redirect_uri });
  }

  const loginButton = document.getElementById('MyLogin');

  // "Login with GitHub" (underlined) or "username (Log Out)": the username links to the GitHub
  // profile, only Log Out logs out
  const render = (user) => {
    if (!user) {
      loginButton.classList.remove('in');
      setChildren(loginButton, "Login with GitHub");

      return;
    }
    const logOut = async (e) => {
      e.preventDefault();
      await session.logout();
    };
    loginButton.classList.add('in');
    setChildren(
      loginButton,
      el("a", {href: `https://github.com/${encodeURIComponent(user.login)}`, target: "_blank", rel: "noopener"}, user.login),
      " (",
      el("a", {href: "#", onclick: logOut}, "Log Out"),
      ")"
    );
  };

  // there is no inline onclick any more in the html pages (Content-Security-Policy)
  loginButton.onclick = async () => {
    if (session.current()) {
      return;
    }
    if (mock) {
      (await api.getMockBackend()).loginAs("mockuser");
      await session.refresh();
    } else {
      hello('github').login();
    }
  };

  session.onChange(render);
  render(session.current());

  if (!mock) {
    hello.on('auth.login', async (auth) => {
      const accessToken = auth.authResponse.access_token;
      try {
        // GitHub no longer accepts the token as a query parameter (what hello's
        // api('me') sends), it has to go in the Authorization header
        const res = await (await fetch("https://api.github.com/user", {
          headers: {Authorization: `Bearer ${accessToken}`}
        })).json();
        if (!res.id) {
          throw new Error(res.message || "GitHub user request failed");
        }
        authData.authData.id = res.id;
        authData.authData.access_token = accessToken;
        var user = new Parse.User();
        await user._linkWith("github", authData);
        // the name shown comes from the server (me), not from this browser
        await session.refresh();
        // the token is not needed any more: remove what the SDK and hello.js stored
        session.stripStoredToken();
        session.forgetHelloSession();
      } catch (err) {
        console.log("ERROR:", err);
      }
    });
  }

  // restore a previous session (Parse.User.current() verified with me())
  await session.init();
};
