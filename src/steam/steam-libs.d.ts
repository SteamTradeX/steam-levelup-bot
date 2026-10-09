/**
 * Minimal declarations for the Steam libraries.
 *
 * They are plain JavaScript and ship no types. Rather than pull in a community
 * types package as another dependency to keep current in a process holding
 * Steam credentials, only the surface actually used is declared here, which
 * also makes it obvious how small that surface is.
 */

declare module "steam-user" {
  import { EventEmitter } from "node:events";

  type LogOnDetails = {
    accountName?: string;
    password?: string;
    twoFactorCode?: string;
    refreshToken?: string;
    logonID?: number;
  };

  class SteamUser extends EventEmitter {
    /* Named explicitly rather than left as an index signature, so the values
       actually used are known to be present rather than possibly undefined. */
    static EPersonaState: {
      Offline: number;
      Online: number;
      Busy: number;
      Away: number;
      Snooze: number;
      [key: string]: number;
    };
    static EResult: Record<string, number> & Record<number, string>;

    steamID: { getSteamID64(): string } | null;

    /* Friends and chat. `myFriends` maps a
       SteamID64 to an EFriendRelationship, where 3 is "Friend". */
    myFriends: Record<string, number>;
    addFriend(steamID: string): Promise<{ personaName?: string }>;
    /* One ClientRemoveFriend message on the signed in connection; no answer, and the person is sent nothing (declared for the type; the free bot never removes a friend). */
    removeFriend(steamID: string): void;
    chat: {
      sendFriendMessage(steamID: string, message: string): Promise<unknown>;
    };

    logOn(details: LogOnDetails): void;
    logOff(): void;
    setPersona(state: number, name?: string): void;
    /* steam-user 5.3: a string is shown as a non-Steam game with that title.
       An empty list clears it. `force` kicks a session playing elsewhere and
       is never passed. */
    gamesPlayed(apps: string | number | ReadonlyArray<string | number | { game_id: number | string; game_extra_info?: string }>, force?: boolean): void;
    /* Whether another session on the account is in game, kept current by the
       library. Reported through the "playingState" event just after logon
       (only when blocked) and whenever a game starts or stops elsewhere. */
    playingState: { blocked: boolean; appid: number };
    on(event: "playingState", listener: (blocked: boolean, playingApp: number) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    webLogOn(): void;
  }

  export = SteamUser;
}

declare module "steam-totp" {
  const SteamTotp: {
    generateAuthCode(sharedSecret: string, timeOffset?: number): string;
    getConfirmationKey(identitySecret: string, time: number, tag: string): string;
    time(offset?: number): number;
    getTimeOffset(callback: (error: Error | null, offset: number) => void): void;
  };
  export = SteamTotp;
}

declare module "steamcommunity" {
  import { EventEmitter } from "node:events";

  class SteamCommunity extends EventEmitter {
    setCookies(cookies: string[]): void;
    getSteamUser(
      id: unknown,
      callback: (error: Error | null, user: unknown) => void,
    ): void;
    /**
     * Confirms one outgoing trade offer on the mobile authenticator.
     *
     * Declared with the identity secret as a plain string because that is what
     * the library takes. Everywhere above this it is a `Secret`, and it is
     * unwrapped at the call itself so it exists in that form for as short a
     * time as possible.
     */
    acceptConfirmationForObject(
      identitySecret: string,
      objectId: string,
      callback: (error: Error | null) => void,
    ): void;
  }

  export = SteamCommunity;
}

declare module "steam-tradeoffer-manager" {
  import { EventEmitter } from "node:events";

  class TradeOfferManager extends EventEmitter {
    constructor(options: Record<string, unknown>);
    setCookies(cookies: string[], callback?: (error: Error | null) => void): void;
    getOffer(id: string, callback: (error: Error | null, offer: unknown) => void): void;
    getOffers(
      filter: number,
      callback: (error: Error | null, sent: unknown[], received: unknown[]) => void,
    ): void;
    /* The token comes from the customer's trade URL and is needed for anybody
       not on the friends list, which is most people arriving from the site. */
    createOffer(partner: string, token?: string): unknown;
    getUserInventoryContents(
      steamId: string,
      appId: number,
      contextId: number,
      tradableOnly: boolean,
      callback: (error: Error | null, items: unknown[]) => void,
    ): void;
    /* Our own inventory: the bot reads its cards and TF2 keys. */
    getInventoryContents(
      appId: number,
      contextId: number,
      tradableOnly: boolean,
      callback: (error: Error | null, items: unknown[]) => void,
    ): void;
    shutdown(): void;
  }

  export = TradeOfferManager;
}

declare module "steamid" {
  class SteamID {
    constructor(input: string);
    getSteamID64(): string;
    isValid(): boolean;
  }
  export = SteamID;
}
