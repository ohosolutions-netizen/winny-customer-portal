import React, { useEffect, useRef } from "react";
import { AppStore, useApp } from "./store/AppStore.jsx";
import TopNav from "./components/shell/TopNav.jsx";
import Loader from "./components/shell/Loader.jsx";
import Toasts from "./components/shell/Toasts.jsx";
import Modal from "./components/shell/Modal.jsx";
import Dashboard from "./components/dashboard/Dashboard.jsx";
import Wizard from "./components/wizard/Wizard.jsx";
import PayConfirmedScreen from "./components/shell/PayConfirmedScreen.jsx";
import { bootstrap } from "./app/bootstrap.js";

// Runs the boot sequence once, after the UI bridge is registered by AppStore.
function Bootstrapper() {
  const { bump } = useApp();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // guard against a double-mount re-run
    started.current = true;
    bootstrap()
      .catch((e) => console.error("[Winny] boot failed", e))
      .finally(() => bump());
  }, [bump]);
  return null;
}

function Shell() {
  const { state, version } = useApp();
  // `version` subscribes this component to store bumps.
  void version;
  return (
    <div id="app">
      <Loader />
      <TopNav />
      {state.activeView === "wizard" ? <Wizard /> : <Dashboard />}
      {state.payConfirmed ? <PayConfirmedScreen /> : null}
      <Toasts />
      <Modal />
      <Bootstrapper />
    </div>
  );
}

export default function App() {
  return (
    <AppStore>
      <Shell />
    </AppStore>
  );
}
