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
  hello.on('auth.login', (auth) => {
      hello('github').api('me').then((res)=> {
          authData.authData.id = res.id;
          authData.authData.access_token = auth.authResponse.access_token;
          var user = new Parse.User();
          user._linkWith("github", authData).then(usr => {
            document.getElementById('MyLogin').innerHTML
              = /*'<img src="' + res.thumbnail + '" width=16px/> '*/''
              + res.name +" (Log Out)";
  //          document.getElementById('MyLogin').style.display = 'none';
          }, err => console.log("ERROR:", err));
      }, (err) => console.log(err));
  });
};
