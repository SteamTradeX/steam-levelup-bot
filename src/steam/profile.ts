import SteamID from "steamid";

export type ProfileFlags = { readonly tradeBanned: boolean; readonly vacBanned: boolean; readonly limited: boolean };

/** The one call of `steamcommunity` this needs, so a test can hand over a fake. */
export type ProfileReader = {
  getSteamUser(id: unknown, callback: (error: Error | null, user: unknown) => void): void;
};

/**
 * The three things the customer filters look at on a Steam profile.
 *
 * Handed a SteamID object, never the id as a string: the library reads a
 * string as a custom profile name and would look up somebody else entirely.
 */
export function readSteamProfile(community: ProfileReader, steamId: string): Promise<ProfileFlags> {
  return new Promise((resolve, reject) => {
    community.getSteamUser(new SteamID(steamId), (error, user) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof user !== "object" || user === null) {
        reject(new Error(`Steam sent no profile for ${steamId}`));
        return;
      }
      const tradeBanState = Reflect.get(user, "tradeBanState");
      resolve({
        /* "None" is the only state that means no ban; anything else, including
           "Probation", is treated as a ban, which is the cautious reading. */
        tradeBanned: typeof tradeBanState === "string" && tradeBanState !== "None",
        vacBanned: Reflect.get(user, "vacBanned") === true,
        limited: Reflect.get(user, "isLimitedAccount") === true,
      });
    });
  });
}
