export const init = async () => {
  const res = await fetch("/config.json");
  const {
    parseAppId,
    serverURL,
    githubClientId,
    oauth_proxy,
    redirect_uri
  } = await res.json();

  Parse.initialize(parseAppId);
  Parse.serverURL = serverURL; // "http://localhost:1337/parse"
  
  const authData = {
    authData: {
      access_token: 'TO_REPLACE',
      id: githubClientId
    }
  };

  const provider = {
    authenticate(options) {if (options.success) {options.success(this, {});}},
    restoreAuthentication(authData) {},
    getAuthType() {return 'github';},
    deauthenticate() {}
  };

  hello.init({ github: githubClientId }, { oauth_proxy, redirect_uri });
  const loginButton = document.getElementById('MyLogin');
  let loggedIn = false;
  // overrides the inline onclick in the html pages
  loginButton.onclick = () => {
    if (!loggedIn) {
      hello('github').login();
    }
  };

  const logOut = async (e) => {
    e.preventDefault();
    try {
      await Parse.User.logOut();
    } catch (err) {
      console.log("ERROR:", err);
    }
    hello('github').logout();
    loggedIn = false;
    loginButton.classList.remove('in');
    loginButton.innerHTML = "Login with GitHub";
  };

  // "username (Log Out)": username links to the GitHub profile, only Log Out logs out
  const showLoggedIn = (username) => {
    const profile = document.createElement('a');
    profile.href = `https://github.com/${encodeURIComponent(username)}`;
    profile.target = "_blank";
    profile.rel = "noopener";
    profile.textContent = username;
    const logout = document.createElement('a');
    logout.href = "#";
    logout.textContent = "Log Out";
    logout.addEventListener('click', logOut);
    loginButton.classList.add('in');
    loginButton.replaceChildren(profile, " (", logout, ")");
  };

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
      loggedIn = true;
      showLoggedIn(res.login);
    } catch (err) {
      console.log("ERROR:", err);
    }
  });
};
