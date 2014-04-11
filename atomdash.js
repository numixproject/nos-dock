// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const AppDisplay = imports.ui.appDisplay;
const AppFavorites = imports.ui.appFavorites;
const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

let DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME;
let DASH_ITEM_LABEL_SHOW_TIME = Dash.DASH_ITEM_LABEL_SHOW_TIME;
let DASH_ITEM_LABEL_HIDE_TIME = Dash.DASH_ITEM_LABEL_HIDE_TIME;
let DASH_ITEM_HOVER_TIMEOUT = Dash.DASH_ITEM_HOVER_TIMEOUT;

const AtomDashItemContainer = new Lang.Class({
    Name: 'AtomDashItemContainer',
    Extends: Dash.DashItemContainer,

    _init: function() {
        this.parent();
    },

    showLabel: function() {

        if (!this._labelText)
            return;

        this.label.set_text(this._labelText);
        this.label.opacity = 0;
        this.label.show();

        let [stageX, stageY] = this.get_transformed_position();

        let labelHeight = this.label.get_height();
        let labelWidth = this.label.get_width();

        let node = this.label.get_theme_node();
        let yOffset = node.get_length('-x-offset'); // borrowing from x-offset

        let y = stageY - labelHeight - yOffset;

        let itemWidth = this.allocation.x2 - this.allocation.x1;
        let xOffset = Math.floor((itemWidth - labelWidth) / 2);

        let x = stageX + xOffset;

        this.label.set_position(x, y);
        Tweener.addTween(this.label,
                         { opacity: 255,
                           time: DASH_ITEM_LABEL_SHOW_TIME,
                           transition: 'easeOutQuad',
                         });

    }
});

/* This class is a fork of the upstream DashActor class (ui.dash.js).
 * Heavily inspired from Michele's Dash to Dock extension
 * https://github.com/micheleg/dash-to-dock
 */
const AtomDashActor = new Lang.Class({
    Name: 'AtomDashActor',
    Extends: St.Widget,

    _init: function() {

        let layout = new Clutter.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL });
        this.parent({ name: 'dash',
                      layout_manager: layout,
                      clip_to_allocation: true });
    },

    vfunc_allocate: function(box, flags) {

        let contentBox = this.get_theme_node().get_content_box(box);
        let availWidth = contentBox.x2 - contentBox.x1;

        this.set_allocation(box, flags);

        let [appIcons, showAppsButton] = this.get_children();
        let [, showAppsNatWidth] = showAppsButton.get_preferred_width(availWidth);

        let childBox = new Clutter.ActorBox();
        childBox.x1 = contentBox.x1;
        childBox.y1 = contentBox.y1;
        childBox.x2 = contentBox.x2 - showAppsNatWidth;
        childBox.y2 = contentBox.y2;
        appIcons.allocate(childBox, flags);

        childBox.x1 = contentBox.x2 - showAppsNatWidth;
        childBox.x2 = contentBox.x2;
        showAppsButton.allocate(childBox, flags);
    },

    vfunc_get_preferred_width: function(forHeight) {

        // We want to request the natural height of all our children
        // as our natural height, so we chain up to StWidget (which
        // then calls BoxLayout), but we only request the showApps
        // button as the minimum size

        let [, natWidth] = this.parent(forHeight);

        let themeNode = this.get_theme_node();
        let adjustedForHeight = themeNode.adjust_for_height(forHeight);
        let [, showAppsButton] = this.get_children();
        let [minWidth, ] = showAppsButton.get_preferred_width(adjustedForHeight);
        [minWidth, ] = themeNode.adjust_preferred_width(minWidth, natWidth);

        return [minWidth, natWidth];
    }
});

/* This class is a fork of the upstream Dash class (ui.dash.js).
 * Heavily inspired from Michele's Dash to Dock extension
 * https://github.com/micheleg/dash-to-dock
 */
const AtomDash = new Lang.Class({
    Name: 'AtomDash',

    _init: function() {

        this._signalHandler = new Convenience.GlobalSignalHandler();
        // 75% of monitor width as icon size adjustment threshold
        this._monitorWidth = Math.floor(Main.layoutManager.primaryMonitor.width * 0.75);

        this._maxWidth = -1;
        this.iconSize = 64;
        this._shownInitially = false;

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._animatingPlaceholdersCount = 0;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._labelShowing = false;

        this._container = new AtomDashActor();
        this._box = new St.BoxLayout({ vertical: false,
                                       clip_to_allocation: true });
        this._box._delegate = this;
        this._container.add_actor(this._box);

        this._showAppsIcon = new Dash.ShowAppsIcon();
        this._showAppsIcon.childScale = 1;
        this._showAppsIcon.childOpacity = 255;
        this._showAppsIcon.icon.setIconSize(this.iconSize);
        this._hookUpLabel(this._showAppsIcon);

        this.showAppsButton = this._showAppsIcon.toggleButton;

        this._container.add_actor(this._showAppsIcon);

        this.actor = new St.Bin({ child: this._container });
        this.actor.connect('notify::width', Lang.bind(this,
            function() {
                if (this._maxWidth != this.actor.width)
                    this._queueRedisplay();
                this._maxWidth = this.actor.width;
            }));

        this._workId = Main.initializeDeferredWork(this._box, Lang.bind(this, this._redisplay));

        this._appSystem = Shell.AppSystem.get_default();

        this._signalHandler.push(
            [
                this._appSystem,
                'installed-changed',
                Lang.bind(this, function() {
                    AppFavorites.getAppFavorites().reload();
                    this._queueRedisplay();
                })
            ],
            [
                AppFavorites.getAppFavorites(),
                'changed',
                Lang.bind(this, this._queueRedisplay)
            ],
            [
                this._appSystem,
                'app-state-changed',
                Lang.bind(this, this._queueRedisplay)
            ],
            [
                Main.overview,
                'item-drag-begin',
                Lang.bind(this, this._onDragBegin)
            ],
            [
                Main.overview,
                'item-drag-end',
                Lang.bind(this, this._onDragEnd)
            ],
            [
                Main.overview,
                'item-drag-cancelled',
                Lang.bind(this, this._onDragCancelled)
            ]
        );

        // Translators: this is the name of the dock/favorites area on
        // the left of the overview
        Main.ctrlAltTabManager.addGroup(this.actor, _("Dash"), 'user-bookmarks-symbolic');
    },

    destroy: function() {
        this._signalHandler.disconnect();
    },

    _onDragBegin: function() {

        this._dragCancelled = false;
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };
        DND.addDragMonitor(this._dragMonitor);

        if (this._box.get_n_children() === 0) {
            this._emptyDropTarget = new Dash.EmptyDropTargetItem();
            this._box.insert_child_at_index(this._emptyDropTarget, 0);
            this._emptyDropTarget.show(true);
        }
    },

    _onDragCancelled: function() {

        this._dragCancelled = true;
        this._endDrag();
    },

    _onDragEnd: function() {

        if (this._dragCancelled)
            return;

        this._endDrag();
    },

    _endDrag: function() {

        this._clearDragPlaceholder();
        this._clearEmptyDropTarget();
        this._showAppsIcon.setDragApp(null);
        DND.removeDragMonitor(this._dragMonitor);
    },

    _onDragMotion: function(dragEvent) {

        let app = Dash.getAppFromSource(dragEvent.source);
        if (app === null)
            return DND.DragMotionResult.CONTINUE;

        let showAppsHovered =
                this._showAppsIcon.contains(dragEvent.targetActor);

        if (!this._box.contains(dragEvent.targetActor) || showAppsHovered)
            this._clearDragPlaceholder();

        if (showAppsHovered)
            this._showAppsIcon.setDragApp(app);
        else
            this._showAppsIcon.setDragApp(null);

        return DND.DragMotionResult.CONTINUE;
    },

    _appIdListToHash: function(apps) {

        let ids = {};
        for (let i = 0; i < apps.length; i++)
            ids[apps[i].get_id()] = apps[i];
        return ids;
    },

    _queueRedisplay: function () {
        Main.queueDeferredWork(this._workId);
    },

    _hookUpLabel: function(item, appIcon) {

        item.child.connect('notify::hover', Lang.bind(this, function() {
            this._syncLabel(item, appIcon);
        }));

        Main.overview.connect('hiding', Lang.bind(this, function() {
            this._labelShowing = false;
            item.hideLabel();
        }));

        if (appIcon) {
            appIcon.connect('sync-tooltip', Lang.bind(this, function() {
                this._syncLabel(item, appIcon);
            }));
        }
    },

    _createAppItem: function(app) {

        let appIcon = new AppDisplay.AppIcon(app,
                                             { setSizeManually: true,
                                               showLabel: false });
        appIcon._draggable.connect('drag-begin',
                                   Lang.bind(this, function() {
                                       appIcon.actor.opacity = 50;
                                   }));
        appIcon._draggable.connect('drag-end',
                                   Lang.bind(this, function() {
                                       appIcon.actor.opacity = 255;
                                   }));
        appIcon.connect('menu-state-changed',
                        Lang.bind(this, function(appIcon, opened) {
                            this._itemMenuStateChanged(item, opened);
                        }));

        let item = new AtomDashItemContainer();
        item.setChild(appIcon.actor);

        // Override default AppIcon label_actor, now the
        // accessible_name is set at DashItemContainer.setLabelText
        appIcon.actor.label_actor = null;
        item.setLabelText(app.get_name());

        appIcon.icon.setIconSize(this.iconSize);
        this._hookUpLabel(item, appIcon);

        return item;
    },

    _itemMenuStateChanged: function(item, opened) {

        // When the menu closes, it calls sync_hover, which means
        // that the notify::hover handler does everything we need to.
        if (opened) {
            if (this._showLabelTimeoutId > 0) {
                Mainloop.source_remove(this._showLabelTimeoutId);
                this._showLabelTimeoutId = 0;
            }

            item.hideLabel();
        }
    },

    _syncLabel: function (item, appIcon) {

        let shouldShow = appIcon ? appIcon.shouldShowTooltip() : item.child.get_hover();

        if (shouldShow) {
            if (this._showLabelTimeoutId === 0) {
                let timeout = this._labelShowing ? 0 : DASH_ITEM_HOVER_TIMEOUT;
                this._showLabelTimeoutId = Mainloop.timeout_add(timeout,
                    Lang.bind(this, function() {
                        this._labelShowing = true;
                        item.showLabel();
                        return false;
                    }));
                if (this._resetHoverTimeoutId > 0) {
                    Mainloop.source_remove(this._resetHoverTimeoutId);
                    this._resetHoverTimeoutId = 0;
                }
            }
        } else {
            if (this._showLabelTimeoutId > 0)
                Mainloop.source_remove(this._showLabelTimeoutId);
            this._showLabelTimeoutId = 0;
            item.hideLabel();
            if (this._labelShowing) {
                this._resetHoverTimeoutId = Mainloop.timeout_add(DASH_ITEM_HOVER_TIMEOUT,
                    Lang.bind(this, function() {
                        this._labelShowing = false;
                        return false;
                    }));
            }
        }
    },

    _adjustIconSize: function() {

        // For the icon size, we only consider children which are "proper"
        // icons (i.e. ignoring drag placeholders) and which are not
        // animating out (which means they will be destroyed at the end of
        // the animation)
        let iconChildren = this._box.get_children().filter(function(actor) {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.icon &&
                   !actor.animatingOut;
        });

        iconChildren.push(this._showAppsIcon);

        if (this._maxWidth == -1) {
            return;
        }

        let themeNode = this._container.get_theme_node();
        let maxAllocation = new Clutter.ActorBox({ x1: 0, y1: 0,
                                                   x2: this._monitorWidth,
                                                   y2: 42 /* whatever */ });
        let maxContent = themeNode.get_content_box(maxAllocation);
        let availWidth = maxContent.x2 - maxContent.x1;
        let spacing = themeNode.get_length('spacing');

        let firstButton = iconChildren[0].child;
        let firstIcon = firstButton._delegate.icon;

        let minWidth, natWidth;

        // Enforce the current icon size during the size request
        let [currentWidth, currentHeight] = firstIcon.icon.get_size();

        firstIcon.icon.set_size(this.iconSize, this.iconSize);
        [minWidth, natWidth] = firstButton.get_preferred_width(-1);

        firstIcon.icon.set_size(currentWidth, currentHeight);

        // Subtract icon padding and box spacing from the available width
        availWidth -= iconChildren.length * (natWidth - this.iconSize) +
                       (iconChildren.length - 1) * spacing;

        let availSize = availWidth / iconChildren.length;

        let iconSizes = [ /*16, 22,*/ 24, 32, 48/*, 64*/ ];

        let newIconSize = 24;
        for (let i = 0; i < iconSizes.length; i++) {
            if (iconSizes[i] <= availSize)
                newIconSize = iconSizes[i];
        }

        if (newIconSize == this.iconSize)
            return;

        let oldIconSize = this.iconSize;
        this.iconSize = newIconSize;

        let scale = oldIconSize / newIconSize;
        for (let i = 0; i < iconChildren.length; i++) {
            let icon = iconChildren[i].child._delegate.icon;

            // Set the new size immediately, to keep the icons' sizes
            // in sync with this.iconSize
            icon.setIconSize(this.iconSize);

            // Don't animate the icon size change when the overview
            // is transitioning, not visible or when initially filling
            // the dash
            if (!Main.overview.visible || Main.overview.animationInProgress ||
                !this._shownInitially) {
                continue;
            }

            let [targetWidth, targetHeight] = icon.icon.get_size();

            // Scale the icon's texture to the previous size and
            // tween to the new size
            icon.icon.set_size(icon.icon.width * scale,
                               icon.icon.height * scale);

            Tweener.addTween(icon.icon,
                             { width: targetWidth,
                               height: targetHeight,
                               time: DASH_ANIMATION_TIME,
                               transition: 'easeOutQuad',
                             });
        }
        // Moved event emitter in the end for AtomDock resetPosition event
        this.emit('icon-size-changed');
    },

    _redisplay: function () {

        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let running = this._appSystem.get_running();

        let children = this._box.get_children().filter(function(actor) {
                return actor.child &&
                       actor.child._delegate &&
                       actor.child._delegate.app;
            });
        // Apps currently in the dash
        let oldApps = children.map(function(actor) {
                return actor.child._delegate.app;
            });
        // Apps supposed to be in the dash
        let newApps = [];

        for (let id in favorites)
            newApps.push(favorites[id]);

        for (let i = 0; i < running.length; i++) {
            let app = running[i];
            if (app.get_id() in favorites)
                continue;
            newApps.push(app);
        }

        // Figure out the actual changes to the list of items; we iterate
        // over both the list of items currently in the dash and the list
        // of items expected there, and collect additions and removals.
        // Moves are both an addition and a removal, where the order of
        // the operations depends on whether we encounter the position
        // where the item has been added first or the one from where it
        // was removed.
        // There is an assumption that only one item is moved at a given
        // time; when moving several items at once, everything will still
        // end up at the right position, but there might be additional
        // additions/removals (e.g. it might remove all the launchers
        // and add them back in the new order even if a smaller set of
        // additions and removals is possible).
        // If above assumptions turns out to be a problem, we might need
        // to use a more sophisticated algorithm, e.g. Longest Common
        // Subsequence as used by diff.
        let addedItems = [];
        let removedActors = [];

        let newIndex = 0;
        let oldIndex = 0;
        while (newIndex < newApps.length || oldIndex < oldApps.length) {
            // No change at oldIndex/newIndex
            if (oldApps[oldIndex] == newApps[newIndex]) {
                oldIndex++;
                newIndex++;
                continue;
            }

            // App removed at oldIndex
            if (oldApps[oldIndex] &&
                newApps.indexOf(oldApps[oldIndex]) == -1) {
                removedActors.push(children[oldIndex]);
                oldIndex++;
                continue;
            }

            // App added at newIndex
            if (newApps[newIndex] &&
                oldApps.indexOf(newApps[newIndex]) == -1) {
                addedItems.push({ app: newApps[newIndex],
                                  item: this._createAppItem(newApps[newIndex]),
                                  pos: newIndex });
                newIndex++;
                continue;
            }

            // App moved
            let insertHere = newApps[newIndex + 1] &&
                             newApps[newIndex + 1] == oldApps[oldIndex];
            let alreadyRemoved = removedActors.reduce(function(result, actor) {
                let removedApp = actor.child._delegate.app;
                return result || removedApp == newApps[newIndex];
            }, false);

            if (insertHere || alreadyRemoved) {
                let newItem = this._createAppItem(newApps[newIndex]);
                addedItems.push({ app: newApps[newIndex],
                                  item: newItem,
                                  pos: newIndex + removedActors.length });
                newIndex++;
            } else {
                removedActors.push(children[oldIndex]);
                oldIndex++;
            }
        }

        for (let i = 0; i < addedItems.length; i++)
            this._box.insert_child_at_index(addedItems[i].item,
                                            addedItems[i].pos);

        for (let i = 0; i < removedActors.length; i++) {
            let item = removedActors[i];

            // Don't animate item removal when the overview is transitioning
            // or hidden
            if (Main.overview.visible && !Main.overview.animationInProgress)
                item.animateOutAndDestroy();
            else
                item.destroy();
        }

        this._adjustIconSize();

        // Skip animations on first run when adding the initial set
        // of items, to avoid all items zooming in at once

        let animate = this._shownInitially && Main.overview.visible &&
            !Main.overview.animationInProgress;

        if (!this._shownInitially)
            this._shownInitially = true;

        for (let i = 0; i < addedItems.length; i++) {
            addedItems[i].item.show(animate);
        }

        // Workaround for https://bugzilla.gnome.org/show_bug.cgi?id=692744
        // Without it, StBoxLayout may use a stale size cache
        this._box.queue_relayout();
    },

    _clearDragPlaceholder: function() {

        if (this._dragPlaceholder) {
            this._animatingPlaceholdersCount++;
            this._dragPlaceholder.animateOutAndDestroy();
            this._dragPlaceholder.connect('destroy',
                Lang.bind(this, function() {
                    this._animatingPlaceholdersCount--;
                }));
            this._dragPlaceholder = null;
        }
        this._dragPlaceholderPos = -1;
    },

    _clearEmptyDropTarget: function() {

        if (this._emptyDropTarget) {
            this._emptyDropTarget.animateOutAndDestroy();
            this._emptyDropTarget = null;
        }
    },

    handleDragOver : function(source, actor, x, y, time) {

        let app = Dash.getAppFromSource(source);

        // Don't allow favoriting of transient apps
        if (app === null || app.is_window_backed())
            return DND.DragMotionResult.NO_DROP;

        let favorites = AppFavorites.getAppFavorites().getFavorites();
        let numFavorites = favorites.length;

        let favPos = favorites.indexOf(app);

        let children = this._box.get_children();
        let numChildren = children.length;
        let boxWidth = this._box.width;

        // Keep the placeholder out of the index calculation; assuming that
        // the remove target has the same size as "normal" items, we don't
        // need to do the same adjustment there.
        if (this._dragPlaceholder) {
            boxWidth -= this._dragPlaceholder.width;
            numChildren--;
        }

        let pos;
        if (!this._emptyDropTarget) {
            pos = Math.floor(x * numChildren / boxWidth);
        } else {
            pos = 0; // always insert at the top when dash is empty
        }

        if (pos != this._dragPlaceholderPos && pos <= numFavorites && this._animatingPlaceholdersCount === 0) {
            this._dragPlaceholderPos = pos;

            // Don't allow positioning before or after self
            if (favPos != -1 && (pos == favPos || pos == favPos + 1)) {
                this._clearDragPlaceholder();
                return DND.DragMotionResult.CONTINUE;
            }

            // If the placeholder already exists, we just move
            // it, but if we are adding it, expand its size in
            // an animation
            let fadeIn;
            if (this._dragPlaceholder) {
                this._dragPlaceholder.destroy();
                fadeIn = false;
            } else {
                fadeIn = true;
            }

            this._dragPlaceholder = new Dash.DragPlaceholderItem();
            this._dragPlaceholder.child.set_width (this.iconSize / 2);
            this._dragPlaceholder.child.set_height (this.iconSize);
            this._box.insert_child_at_index(this._dragPlaceholder,
                                            this._dragPlaceholderPos);
            this._dragPlaceholder.show(fadeIn);
        }

        // Remove the drag placeholder if we are not in the
        // "favorites zone"
        if (pos > numFavorites) {
            this._clearDragPlaceholder();
        }

        if (!this._dragPlaceholder) {
            return DND.DragMotionResult.NO_DROP;
        }

        let srcIsFavorite = (favPos != -1);

        if (srcIsFavorite) {
            return DND.DragMotionResult.MOVE_DROP;
        }

        return DND.DragMotionResult.COPY_DROP;
    },

    // Draggable target interface
    acceptDrop : function(source, actor, x, y, time) {

        let app = Dash.getAppFromSource(source);

        // Don't allow favoriting of transient apps
        if (app === null || app.is_window_backed()) {
            return false;
        }

        let id = app.get_id();

        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let srcIsFavorite = (id in favorites);

        let favPos = 0;
        let children = this._box.get_children();
        for (let i = 0; i < this._dragPlaceholderPos; i++) {
            if (this._dragPlaceholder &&
                children[i] == this._dragPlaceholder)
                continue;

            let childId = children[i].child._delegate.app.get_id();
            if (childId == id)
                continue;
            if (childId in favorites)
                favPos++;
        }

        // No drag placeholder means we don't wan't to favorite the app
        // and we are dragging it to its original position
        if (!this._dragPlaceholder)
            return true;

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
            function () {
                let appFavorites = AppFavorites.getAppFavorites();
                if (srcIsFavorite)
                    appFavorites.moveFavoriteToPos(id, favPos);
                else
                    appFavorites.addFavoriteAtPos(id, favPos);
                return false;
            }));

        return true;
    }

});

Signals.addSignalMethods(AtomDash.prototype);
