"use client";

import { Button } from "@/components/ui/button";

export default function LogoutButton() {
  const handleLogout = () => {
    window.location.href = "/auth/logout";
  };

  return (
    <Button variant="outline" onClick={handleLogout}>
      Log out
    </Button>
  );
}
